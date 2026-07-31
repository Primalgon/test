import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { rateLimit } from '../middleware/rate-limit';
import { csrfProtect } from '../middleware/auth';
import { all, one, run, nowSec, newId } from '../db/client';
import { audit } from '../db/repo';
import { badRequest, forbidden } from '../lib/errors';
import { verifyTurnstile } from '../services/cloudflare';
import { sendMail, renderEmail, escapeHtml } from '../services/mail';
import { emit } from '../services/events';

const site = new Hono<AppContext>();

/** Public config the frontend needs at boot. No secrets, cacheable. */
site.get('/config', async (c) => {
  const caps = c.get('caps');
  c.header('cache-control', 'public, max-age=60, stale-while-revalidate=600');
  return c.json({
    site: { name: c.env.SITE_NAME, slug: c.env.SITE_SLUG, origin: c.env.PUBLIC_ORIGIN },
    features: {
      payments: caps.has('stripe'),
      contact_form: true,
      accounts: true,
      turnstile: caps.has('turnstile'),
    },
    stripe_publishable_key: caps.has('stripe') ? c.env.STRIPE_PUBLISHABLE_KEY ?? null : null,
  });
});

/** Editable copy, keyed by page + block. Powers the admin's inline editing. */
site.get('/content/:page{.*}', async (c) => {
  const page = c.req.param('page') || 'home';
  const locale = c.req.query('locale') ?? 'en-US';
  const rows = await all<{ block_key: string; value: string }>(
    c.get('db'),
    'SELECT block_key, value FROM content_blocks WHERE page_slug = ? AND locale = ?',
    [page, locale]);
  const blocks: Record<string, string> = {};
  for (const r of rows) blocks[r.block_key] = r.value;
  c.header('cache-control', 'public, max-age=30, stale-while-revalidate=300');
  return c.json({ page, locale, blocks });
});

/** Current 3D asset state — lets the frontend show real status in the dashboard. */
site.get('/assets', async (c) => {
  const rows = await all(c.get('db'),
    'SELECT asset_key,status,source,url,poster_url,bytes,triangles,updated_at FROM assets ORDER BY asset_key');
  return c.json({ assets: rows });
});

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Tell us your name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  message: z.string().trim().min(10, 'Add a bit more detail.').max(5000),
  phone: z.string().trim().max(40).optional(),
  subject: z.string().trim().max(200).optional(),
  form_key: z.string().trim().max(60).default('contact'),
  turnstile_token: z.string().optional(),
  // Honeypot. Real users never fill this; bots fill everything.
  company_website: z.string().max(0, 'Rejected.').optional(),
});

site.post('/contact',
  rateLimit({ bucket: 'contact', limit: 5, windowSec: 3600 }),
  async (c) => {
    const input = contactSchema.parse(await c.req.json().catch(() => ({})));

    if (c.get('caps').has('turnstile')) {
      const check = await verifyTurnstile(c.env, input.turnstile_token ?? '', c.get('ip'));
      if (!check.ok) throw forbidden('Verification failed. Reload the page and try again.');
    }

    const spam = scoreSpam(input.message, input.name);
    const db = c.get('db');
    const id = newId('sub');

    await run(db,
      `INSERT INTO submissions (id,form_key,payload,email,ip_hash,user_agent,spam_score,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.form_key, JSON.stringify({
        name: input.name, email: input.email, phone: input.phone,
        subject: input.subject, message: input.message,
      }), input.email, c.get('ipHash'), (c.req.header('user-agent') ?? '').slice(0, 300),
       spam, spam > 0.8 ? 'spam' : 'new', nowSec()]);

    if (spam <= 0.8) {
      c.executionCtx.waitUntil((async () => {
        if (c.get('caps').has('mail')) {
          await sendMail(c.env, {
            to: [{ email: c.env.MAIL_FROM }],
            replyTo: { email: input.email, name: input.name },
            subject: `New enquiry: ${input.subject ?? input.name}`,
            html: renderEmail({
              siteName: c.env.SITE_NAME,
              heading: `New message from ${input.name}`,
              bodyHtml: `<p style="white-space:pre-wrap;">${escapeHtml(input.message)}</p>
                <p style="margin-top:18px;font-size:14px;color:#6b7280;">${escapeHtml(input.email)}${input.phone ? ' &middot; ' + escapeHtml(input.phone) : ''}</p>`,
            }),
          }).catch((e) => c.get('log').error('contact_notify_failed', { error: String(e) }));

          await sendMail(c.env, {
            to: [{ email: input.email, name: input.name }],
            subject: `We got your message — ${c.env.SITE_NAME}`,
            html: renderEmail({
              siteName: c.env.SITE_NAME,
              heading: 'Message received',
              bodyHtml: `<p>Thanks for getting in touch. Someone will reply to this address shortly.</p>`,
            }),
          }).catch(() => {});
        }
        await emit(db, c.env, 'submission.received', {
          submission_id: id, form_key: input.form_key,
          name: input.name, email: input.email, message: input.message, spam_score: spam,
        }, c.get('requestId'));
      })());
    }

    return c.json({ ok: true, message: 'Thanks — your message is on its way.' }, 201);
  });

/** Cheap heuristic filter that runs before Turnstile costs you anything. */
function scoreSpam(message: string, name: string): number {
  let score = 0;
  const links = (message.match(/https?:\/\//g) ?? []).length;
  if (links >= 2) score += 0.35;
  if (links >= 5) score += 0.35;
  if (/\b(seo|backlink|crypto|casino|viagra|loan offer|guest post)\b/i.test(message)) score += 0.4;
  if (message === message.toUpperCase() && message.length > 40) score += 0.2;
  if (/(.)\1{8,}/.test(message)) score += 0.2;
  if (!/\s/.test(name)) score += 0.05;
  if (/[\u0400-\u04FF\u4e00-\u9fff]/.test(message) && /[a-z]/i.test(message)) score += 0.15;
  return Math.min(1, score);
}

export default site;
