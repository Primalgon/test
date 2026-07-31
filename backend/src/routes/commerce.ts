import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { rateLimit } from '../middleware/rate-limit';
import { csrfProtect } from '../middleware/auth';
import { getStripe, createCheckoutSession, createBillingPortalSession, verifyStripeWebhook, HANDLED_STRIPE_EVENTS } from '../services/stripe';
import { all, one, run, nowSec, newId } from '../db/client';
import {
  claimWebhookEvent, completeWebhookEvent, failWebhookEvent, upsertOrderFromSession,
  setOrderStatusByPaymentIntent, findUserByEmail, audit,
} from '../db/repo';
import { badRequest, notFound, notImplemented, unauthorized } from '../lib/errors';
import { sha256Hex } from '../lib/crypto';
import { emit } from '../services/events';
import { sendMail, renderEmail, escapeHtml } from '../services/mail';
import type Stripe from 'stripe';

const commerce = new Hono<AppContext>();

commerce.get('/products', async (c) => {
  const rows = await all(c.get('db'),
    `SELECT id,sku,name,description,amount_cents,currency,recurring,stripe_price_id,inventory
     FROM products WHERE active = 1 ORDER BY amount_cents ASC`);
  return c.json({ products: rows, currency: rows[0]?.currency ?? 'usd' });
});

const checkoutSchema = z.object({
  items: z.array(z.object({
    sku: z.string().min(1),
    quantity: z.number().int().min(1).max(99),
  })).min(1).max(20),
  email: z.string().email().optional(),
  success_path: z.string().startsWith('/').max(200).default('/thank-you'),
  cancel_path: z.string().startsWith('/').max(200).default('/'),
});

commerce.post('/checkout',
  rateLimit({ bucket: 'checkout', limit: 20, windowSec: 600 }),
  csrfProtect,
  async (c) => {
    if (!c.get('caps').has('stripe')) throw notImplemented('Payments');
    const input = checkoutSchema.parse(await c.req.json().catch(() => ({})));
    const db = c.get('db');

    // Prices are read from our own database, never from the request body.
    // Trusting a client-supplied amount is the single most common way a
    // generated storefront gets drained.
    const placeholders = input.items.map(() => '?').join(',');
    const products = await all<{ sku: string; stripe_price_id: string | null; recurring: string; inventory: number | null; name: string }>(
      db, `SELECT sku,stripe_price_id,recurring,inventory,name FROM products WHERE active = 1 AND sku IN (${placeholders})`,
      input.items.map((i) => i.sku));

    if (products.length !== input.items.length) throw badRequest('One of those items is no longer available.');

    const lineItems: Array<{ price: string; quantity: number }> = [];
    let subscription = false;
    for (const item of input.items) {
      const p = products.find((x) => x.sku === item.sku)!;
      if (!p.stripe_price_id) throw badRequest(`${p.name} is not ready for purchase yet.`);
      if (p.inventory !== null && p.inventory < item.quantity) throw badRequest(`Only ${p.inventory} of ${p.name} left.`);
      if (p.recurring !== 'none') subscription = true;
      lineItems.push({ price: p.stripe_price_id, quantity: item.quantity });
    }

    const user = c.get('user');
    // Same cart + same actor within a short window reuses one Stripe session.
    const idempotencyKey = await sha256Hex(
      JSON.stringify({ items: input.items, who: user?.id ?? c.get('ipHash'), slot: Math.floor(Date.now() / 60000) }),
    );

    const session = await createCheckoutSession(c.env, {
      lineItems,
      mode: subscription ? 'subscription' : 'payment',
      customerEmail: user?.email ?? input.email,
      successUrl: `${c.env.PUBLIC_ORIGIN}${input.success_path}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${c.env.PUBLIC_ORIGIN}${input.cancel_path}`,
      clientReferenceId: user?.id,
      metadata: { site: c.env.SITE_SLUG, user_id: user?.id ?? '', request_id: c.get('requestId') },
      idempotencyKey,
    });

    c.get('log').info('checkout_created', { session_id: session.id, mode: session.mode, subscription });
    return c.json({ ok: true, checkout_url: session.url, session_id: session.id });
  });

commerce.post('/billing-portal', csrfProtect, async (c) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  const row = await one<{ stripe_customer_id: string | null }>(
    c.get('db'), 'SELECT stripe_customer_id FROM users WHERE id = ?', [user.id]);
  if (!row?.stripe_customer_id) throw notFound('No billing account yet.');
  const session = await createBillingPortalSession(c.env, row.stripe_customer_id, `${c.env.PUBLIC_ORIGIN}/account`);
  return c.json({ ok: true, url: session.url });
});

commerce.get('/orders/:id', async (c) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  const order = await one(c.get('db'),
    'SELECT * FROM orders WHERE id = ? AND (user_id = ? OR email = ?)',
    [c.req.param('id'), user.id, user.email]);
  if (!order) throw notFound('Order not found.');
  return c.json({ order });
});

/**
 * Stripe webhook.
 *
 * Order of operations matters and is not negotiable:
 *   1. read the RAW body (any JSON parse first breaks the signature)
 *   2. verify the signature
 *   3. claim the event id for idempotency
 *   4. only then mutate anything
 *
 * Always returns 200 once the signature is valid, even on internal failure —
 * a non-2xx makes Stripe retry, and a poison event would then retry forever.
 * Failures are recorded in webhook_events and surfaced in the admin dashboard.
 */
commerce.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) throw badRequest('Missing signature.');

  const rawBody = await c.req.text();
  const event = await verifyStripeWebhook(c.env, rawBody, signature);
  const db = c.get('db');
  const log = c.get('log').child({ stripe_event: event.type, event_id: event.id });

  const claimed = await claimWebhookEvent(db, event.id, 'stripe', event.type, await sha256Hex(rawBody));
  if (!claimed) {
    log.info('stripe_event_duplicate');
    return c.json({ received: true, duplicate: true });
  }

  if (!HANDLED_STRIPE_EVENTS.has(event.type)) {
    await completeWebhookEvent(db, event.id);
    return c.json({ received: true, ignored: true });
  }

  try {
    await handleStripeEvent(c, event);
    await completeWebhookEvent(db, event.id);
    log.info('stripe_event_processed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failWebhookEvent(db, event.id, message);
    log.error('stripe_event_failed', { error: message });
    // Deliberate 200: see the note above.
  }
  return c.json({ received: true });
});

async function handleStripeEvent(c: any, event: Stripe.Event) {
  const db = c.get('db');
  const env = c.env;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      const email = session.customer_details?.email ?? session.customer_email ?? '';
      const user = email ? await findUserByEmail(db, email) : null;

      // Line items are not included in the webhook payload; fetch them so the
      // order record is complete rather than an opaque total.
      let items: unknown = [];
      try {
        const full = await getStripe(env).checkout.sessions.listLineItems(session.id, { limit: 50 });
        items = full.data.map((li) => ({
          description: li.description, quantity: li.quantity,
          amount_total: li.amount_total, price_id: typeof li.price === 'object' ? li.price?.id : li.price,
        }));
      } catch { /* order still records correctly without the breakdown */ }

      const order = await upsertOrderFromSession(db, {
        sessionId: session.id,
        email,
        userId: user?.id ?? (session.client_reference_id || null),
        amountCents: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
        paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
        status: paid ? 'paid' : 'pending',
        items,
      });

      if (user && typeof session.customer === 'string') {
        await run(db, 'UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?',
          [session.customer, nowSec(), user.id]);
      }

      if (paid) {
        await audit(db, { actorType: 'webhook', action: 'order.paid', entity: 'order', entityId: order?.id, after: { amount: session.amount_total } });
        await emit(db, env, 'order.paid', {
          order_id: order?.id, email, amount_cents: session.amount_total,
          currency: session.currency, items,
        });
        if (c.get('caps').has('mail') && email) {
          await sendMail(env, {
            to: [{ email }],
            subject: `Order confirmed — ${env.SITE_NAME}`,
            html: renderEmail({
              siteName: env.SITE_NAME,
              heading: 'Your order is confirmed',
              bodyHtml: `<p>Thanks — payment went through and we've started on it.</p><p style="margin-top:14px;font-size:14px;color:#6b7280;">Order reference: ${escapeHtml(order?.id ?? session.id)}</p>`,
              cta: { label: 'View your order', url: `${env.PUBLIC_ORIGIN}/account/orders` },
            }),
          }).catch(() => {});
        }
      }
      break;
    }

    case 'payment_intent.payment_failed':
    case 'checkout.session.async_payment_failed': {
      const obj = event.data.object as Stripe.PaymentIntent;
      if (obj.id) await setOrderStatusByPaymentIntent(db, obj.id, 'failed');
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (pi) {
        const full = charge.amount_refunded >= charge.amount;
        await setOrderStatusByPaymentIntent(db, pi, full ? 'refunded' : 'partially_refunded', charge.amount_refunded);
        await emit(db, env, 'order.refunded', { payment_intent: pi, amount_refunded: charge.amount_refunded, full });
      }
      break;
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      await emit(db, env, 'order.disputed', {
        dispute_id: dispute.id, amount: dispute.amount, reason: dispute.reason,
        payment_intent: dispute.payment_intent,
      });
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await run(db, 'UPDATE orders SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?',
        [sub.status === 'active' || sub.status === 'trialing' ? 'paid' : 'cancelled', nowSec(), sub.id]);
      await emit(db, env, 'subscription.changed', {
        subscription_id: sub.id, status: sub.status,
        current_period_end: (sub as any).current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end,
      });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await emit(db, env, 'subscription.changed', {
        invoice_id: invoice.id, status: 'payment_failed',
        customer_email: invoice.customer_email,
      });
      break;
    }
  }
}

export default commerce;
