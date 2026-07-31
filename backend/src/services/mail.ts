import type { Bindings } from '../env';
import { notImplemented, upstream } from '../lib/errors';

/**
 * Transactional mail goes through Zoho's ZeptoMail HTTP API.
 *
 * Why not SMTP: Cloudflare Workers cannot open raw TCP to port 587, so any
 * nodemailer-based approach is dead on arrival here. ZeptoMail is Zoho's
 * transactional product and speaks plain HTTPS with a static token, so it
 * works from the edge with no OAuth dance at request time.
 *
 * The client's *mailboxes* (hello@theirdomain.com etc.) are still real Zoho
 * Mail accounts — those are created once at provisioning time by
 * scripts/provision.ts, which does use the OAuth Admin API. Runtime sending
 * and one-time mailbox creation are deliberately different code paths.
 */
const ZEPTO_ENDPOINT: Record<string, string> = {
  com: 'https://api.zeptomail.com/v1.1/email',
  eu: 'https://api.zeptomail.eu/v1.1/email',
  in: 'https://api.zeptomail.in/v1.1/email',
};

export interface MailMessage {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  html: string;
  text?: string;
  replyTo?: { email: string; name?: string };
  cc?: Array<{ email: string; name?: string }>;
  /** Threads replies and shows up in ZeptoMail reporting. */
  trackingRef?: string;
}

export async function sendMail(env: Bindings, msg: MailMessage): Promise<{ id: string }> {
  if (!env.ZEPTOMAIL_TOKEN) throw notImplemented('Email');
  const endpoint = ZEPTO_ENDPOINT[(env as any).ZOHO_REGION ?? 'com'] ?? ZEPTO_ENDPOINT.com!;

  const body = {
    from: { address: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
    to: msg.to.map((t) => ({ email_address: { address: t.email, name: t.name } })),
    ...(msg.cc?.length ? { cc: msg.cc.map((t) => ({ email_address: { address: t.email, name: t.name } })) } : {}),
    ...(msg.replyTo ? { reply_to: [{ address: msg.replyTo.email, name: msg.replyTo.name }] } : {}),
    subject: msg.subject,
    htmlbody: msg.html,
    textbody: msg.text ?? stripHtml(msg.html),
    ...(msg.trackingRef ? { client_reference: msg.trackingRef } : {}),
    track_opens: false,   // off by default: GDPR-safer and the client can enable it
    track_clicks: false,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      // ZeptoMail expects the whole "Zoho-enczapikey xxx" string as the value.
      authorization: env.ZEPTOMAIL_TOKEN,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw upstream('Zoho ZeptoMail', { status: res.status, detail: detail.slice(0, 400) });
  }
  const json = (await res.json()) as { data?: Array<{ message_id?: string }> };
  return { id: json.data?.[0]?.message_id ?? 'unknown' };
}

const stripHtml = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

/** Minimal, inline-styled, dark-mode-safe shell. Email clients ignore <style> blocks. */
export function renderEmail(opts: {
  siteName: string; heading: string; bodyHtml: string;
  cta?: { label: string; url: string }; footerNote?: string;
}) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:28px 32px 8px;">
<p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">${escapeHtml(opts.siteName)}</p>
<h1 style="margin:10px 0 0;font-size:22px;line-height:1.3;color:#111827;font-weight:650;">${escapeHtml(opts.heading)}</h1>
</td></tr>
<tr><td style="padding:12px 32px 4px;font-size:15px;line-height:1.6;color:#374151;">${opts.bodyHtml}</td></tr>
${opts.cta ? `<tr><td style="padding:20px 32px 8px;">
<a href="${escapeAttr(opts.cta.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-size:15px;font-weight:600;">${escapeHtml(opts.cta.label)}</a>
</td></tr>` : ''}
<tr><td style="padding:22px 32px 30px;font-size:12px;line-height:1.6;color:#9ca3af;border-top:1px solid #eef0f3;">
${opts.footerNote ? escapeHtml(opts.footerNote) + '<br>' : ''}Sent by ${escapeHtml(opts.siteName)}.
</td></tr>
</table></td></tr></table></body></html>`;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/'/g, '&#39;');
