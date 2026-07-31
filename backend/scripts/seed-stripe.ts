#!/usr/bin/env tsx
/**
 * Creates the Stripe catalog for a site from its brief, then writes the
 * resulting price IDs into the site's Turso database.
 *
 *   tsx scripts/seed-stripe.ts --brief ./brief.json
 *   tsx scripts/seed-stripe.ts --brief ./brief.json --webhook https://site.com
 *
 * Runs from Node at provisioning time, never from the Worker. The Worker only
 * ever *reads* prices; it has no capability to create them, which means a
 * compromised edge deployment cannot invent a discounted SKU.
 *
 * Idempotent by design — this script gets re-run every time a brief is
 * amended, and re-running must not produce duplicate products in the client's
 * Stripe dashboard.
 */
import Stripe from 'stripe';
import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const briefPath = arg('brief') ?? './brief.json';
const webhookOrigin = arg('webhook');
const dryRun = args.includes('--dry-run');

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('STRIPE_SECRET_KEY is not set. Nothing to do.');
  process.exit(1);
}
if (stripeKey.startsWith('sk_live') && !args.includes('--live')) {
  console.error('That is a live key. Re-run with --live if you meant it.');
  process.exit(1);
}

// apiVersion deliberately unset — see services/stripe.ts. Pin in the dashboard.
const stripe = new Stripe(stripeKey);

type BriefProduct = {
  sku: string;
  name: string;
  description?: string;
  amount_cents: number;
  currency?: string;
  recurring?: 'none' | 'month' | 'year';
  inventory?: number | null;
  active?: boolean;
};

const brief = JSON.parse(await readFile(briefPath, 'utf8'));
const slug: string = brief.site?.domain?.desired ?? brief.brief_id;
const products: BriefProduct[] = brief.integrations?.stripe?.products ?? [];

if (!brief.integrations?.stripe?.enabled) {
  console.log('Brief does not enable Stripe. Skipping catalog seed.');
  process.exit(0);
}
if (products.length === 0) {
  console.log('Stripe is enabled but the brief lists no products. Checkout will 501 until a catalog exists.');
}

/**
 * Prices in Stripe are immutable — you cannot edit an amount. Changing a price
 * means creating a new one and deactivating the old, and any existing
 * subscription stays on the old price until it is explicitly migrated. So the
 * lookup is: find the active price with our lookup_key, compare the amount, and
 * only mint a new one if it actually differs.
 */
async function ensureProduct(p: BriefProduct) {
  const lookupKey = `${slugKey(slug)}_${p.sku}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 200);
  const currency = (p.currency ?? 'usd').toLowerCase();
  const recurring = p.recurring ?? 'none';

  // Products are found by metadata, not by name — a client renaming a product
  // in the brief should update the existing one rather than orphan it.
  const existing = await stripe.products.search({
    query: `metadata['forge_sku']:'${p.sku}' AND metadata['forge_site']:'${slug}'`,
    limit: 1,
  });

  let product = existing.data[0];
  if (!product) {
    if (dryRun) {
      console.log(`  would create product  ${p.sku}  "${p.name}"`);
      return { sku: p.sku, product_id: 'dry_run', price_id: 'dry_run' };
    }
    product = await stripe.products.create(
      {
        name: p.name,
        description: p.description || undefined,
        active: p.active !== false,
        metadata: { forge_sku: p.sku, forge_site: slug },
      },
      // Idempotency key survives a retry after a network timeout, which is the
      // scenario that otherwise creates two identical products.
      { idempotencyKey: `product_${slug}_${p.sku}` },
    );
    console.log(`  created product       ${p.sku}`);
  } else if (!dryRun) {
    await stripe.products.update(product.id, {
      name: p.name,
      description: p.description || undefined,
      active: p.active !== false,
    });
    console.log(`  updated product       ${p.sku}`);
  }

  // Find the current price by lookup_key.
  const priceList = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const match = priceList.data.find(
    (pr) =>
      pr.lookup_key === lookupKey &&
      pr.unit_amount === p.amount_cents &&
      pr.currency === currency &&
      (recurring === 'none' ? pr.recurring === null : pr.recurring?.interval === recurring),
  );

  if (match) {
    console.log(`  price unchanged       ${p.sku}  ${(p.amount_cents / 100).toFixed(2)} ${currency.toUpperCase()}`);
    return { sku: p.sku, product_id: product.id, price_id: match.id };
  }

  if (dryRun) {
    console.log(`  would create price    ${p.sku}  ${(p.amount_cents / 100).toFixed(2)} ${currency.toUpperCase()}`);
    return { sku: p.sku, product_id: product.id, price_id: 'dry_run' };
  }

  // transfer_lookup_key moves the key off the old price automatically, so the
  // old one stops being resolvable by key but stays alive for existing
  // subscriptions. This is the safe way to change a price.
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: p.amount_cents,
    currency,
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    ...(recurring === 'none' ? {} : { recurring: { interval: recurring } }),
    metadata: { forge_sku: p.sku, forge_site: slug },
  });

  // Deactivate superseded one-off prices so the dashboard stays legible. Never
  // deactivate recurring prices — subscribers are still billed against them.
  if (recurring === 'none') {
    for (const old of priceList.data) {
      if (old.id !== price.id && old.metadata?.forge_sku === p.sku && old.recurring === null) {
        await stripe.prices.update(old.id, { active: false });
      }
    }
  }

  console.log(`  created price         ${p.sku}  ${(p.amount_cents / 100).toFixed(2)} ${currency.toUpperCase()}`);
  return { sku: p.sku, product_id: product.id, price_id: price.id };
}

function slugKey(domain: string) {
  return domain.replace(/^https?:\/\//, '').split('/')[0]!.replace(/\./g, '_');
}

console.log(`Seeding Stripe catalog for ${slug} (${products.length} product${products.length === 1 ? '' : 's'})${dryRun ? ' — DRY RUN' : ''}`);

const results: Array<{ sku: string; product_id: string; price_id: string }> = [];
for (const p of products) {
  try {
    results.push(await ensureProduct(p));
  } catch (err) {
    console.error(`  FAILED ${p.sku}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ *
 * Webhook endpoint
 * ------------------------------------------------------------------ */

if (webhookOrigin && !dryRun) {
  const url = `${webhookOrigin.replace(/\/$/, '')}/api/webhooks/stripe`;
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = existing.data.find((e) => e.url === url);

  if (found) {
    console.log(`\nWebhook endpoint already registered: ${found.id}`);
    console.log('Its signing secret is only shown at creation. If you have lost it, roll it in the');
    console.log('Stripe dashboard and push the new value with scripts/push-secrets.ts.');
  } else {
    const endpoint = await stripe.webhookEndpoints.create({
      url,
      // Only what the backend actually handles. Subscribing to everything means
      // paying to process events the site ignores, and burying real failures.
      enabled_events: [
        'checkout.session.completed',
        'checkout.session.async_payment_failed',
        'payment_intent.payment_failed',
        'charge.refunded',
        'charge.dispute.created',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
      ],
      description: `Forge site ${slug}`,
      metadata: { forge_site: slug },
    });
    console.log(`\nWebhook endpoint created: ${endpoint.id}`);
    console.log('STRIPE_WEBHOOK_SECRET=' + endpoint.secret);
    console.log('^ Put that in .dev.vars and run scripts/push-secrets.ts. It is shown exactly once.');
  }
}

/* ------------------------------------------------------------------ *
 * Mirror into the site's Turso database
 * ------------------------------------------------------------------ */

const tursoUrl = process.env.TURSO_DATABASE_URL;
if (tursoUrl && !dryRun && results.length) {
  const db = createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  const now = Math.floor(Date.now() / 1000);

  for (const p of products) {
    const r = results.find((x) => x.sku === p.sku);
    if (!r) continue;
    await db.execute({
      sql: `INSERT INTO products
              (id,sku,name,description,amount_cents,currency,recurring,stripe_price_id,stripe_product_id,active,inventory,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(sku) DO UPDATE SET
              name=excluded.name, description=excluded.description,
              amount_cents=excluded.amount_cents, currency=excluded.currency,
              recurring=excluded.recurring, stripe_price_id=excluded.stripe_price_id,
              stripe_product_id=excluded.stripe_product_id, active=excluded.active,
              inventory=excluded.inventory, updated_at=excluded.updated_at`,
      args: [
        `prd_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        p.sku, p.name, p.description ?? null, p.amount_cents,
        (p.currency ?? 'usd').toLowerCase(), p.recurring ?? 'none',
        r.price_id, r.product_id, p.active === false ? 0 : 1,
        p.inventory ?? null, now, now,
      ],
    });
  }
  console.log(`\nMirrored ${results.length} product(s) into the site database.`);
  console.log('Checkout resolves amounts from this table and never from the request body —');
  console.log('a client-supplied price is the usual way a generated storefront gets drained.');
} else if (!tursoUrl) {
  console.log('\nTURSO_DATABASE_URL not set — Stripe catalog created but not mirrored to the site DB.');
  console.log('Run again with it set, or POST the catalog to /api/_n8n/catalog/sync.');
}

// Machine-readable tail for the n8n HTTP/Execute-Command node to parse.
console.log('::result::' + JSON.stringify({ ok: process.exitCode !== 1, site: slug, products: results }));
