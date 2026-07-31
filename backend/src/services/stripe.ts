import Stripe from 'stripe';
import type { Bindings } from '../env';
import { notImplemented, upstream } from '../lib/errors';

/**
 * Stripe on Workers requires two non-default options. Without the fetch HTTP
 * client the SDK reaches for node:http and the Worker throws at first call;
 * without the subtle-crypto provider, webhook verification throws because the
 * default provider is synchronous and Workers only exposes async crypto.
 * This is the #1 cause of "works locally, 500s in production" with Stripe.
 */
let cached: { key: string; client: Stripe } | null = null;

export function getStripe(env: Bindings): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw notImplemented('Payments');
  if (cached && cached.key === env.STRIPE_SECRET_KEY) return cached.client;
  const client = new Stripe(env.STRIPE_SECRET_KEY, {
    // Deliberately not pinned. Pinning a literal here fails typecheck whenever
    // the installed SDK's types disagree with the string, which is every time
    // the SDK updates. The SDK defaults to the version its types were generated
    // against, so this is both correct and self-maintaining. Pin it in the
    // Stripe dashboard instead, which is where the pin actually belongs.
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'forge-site-backend', version: '1.0.0' },
  });
  cached = { key: env.STRIPE_SECRET_KEY, client };
  return client;
}

const webhookProvider = Stripe.createSubtleCryptoProvider();

export async function verifyStripeWebhook(
  env: Bindings, rawBody: string, signature: string,
): Promise<Stripe.Event> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw notImplemented('Payments');
  try {
    // constructEventAsync, not constructEvent — the sync version cannot work here.
    return await getStripe(env).webhooks.constructEventAsync(
      rawBody, signature, env.STRIPE_WEBHOOK_SECRET, undefined, webhookProvider,
    );
  } catch (err) {
    throw upstream('Stripe webhook verification', String(err));
  }
}

export interface CheckoutLine { priceId?: string; sku?: string; quantity: number }

export async function createCheckoutSession(env: Bindings, opts: {
  lineItems: Array<{ price: string; quantity: number }>;
  mode: 'payment' | 'subscription';
  customerEmail?: string;
  customerId?: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  taxEnabled?: boolean;
  idempotencyKey: string;
}) {
  const stripe = getStripe(env);
  try {
    return await stripe.checkout.sessions.create(
      {
        line_items: opts.lineItems,
        mode: opts.mode,
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        client_reference_id: opts.clientReferenceId,
        ...(opts.customerId ? { customer: opts.customerId } : { customer_email: opts.customerEmail }),
        customer_creation: opts.mode === 'payment' && !opts.customerId ? 'always' : undefined,
        automatic_tax: { enabled: opts.taxEnabled ?? true },
        // Required by automatic_tax for physical goods and for correct EU VAT.
        billing_address_collection: 'auto',
        tax_id_collection: { enabled: true },
        allow_promotion_codes: true,
        phone_number_collection: { enabled: false },
        metadata: opts.metadata ?? {},
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 2,
      },
      // Guards against a double-click or a retried request creating two sessions.
      { idempotencyKey: opts.idempotencyKey },
    );
  } catch (err) {
    throw upstream('Stripe checkout', err instanceof Error ? err.message : String(err));
  }
}

export async function createBillingPortalSession(env: Bindings, customerId: string, returnUrl: string) {
  try {
    return await getStripe(env).billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  } catch (err) {
    throw upstream('Stripe billing portal', String(err));
  }
}

/** Events this backend acts on. Anything else is acknowledged and ignored. */
export const HANDLED_STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);
