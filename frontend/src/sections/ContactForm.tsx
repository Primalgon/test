import { useState, type FormEvent } from 'react';
import { Section, SectionHead, Button } from './shared';
import { api } from '../lib/api';
import { site } from '../site.config';

/**
 * Contact form.
 *
 * Posts to /api/submissions, which applies rate limiting, Turnstile when it is
 * configured, and stores the submission with the message field encrypted.
 *
 * The honeypot is a real field that is hidden from sighted users and marked
 * aria-hidden with tabIndex -1, so a keyboard or screen-reader user never
 * reaches it and a naive bot fills it in. It costs nothing and removes most
 * automated spam without a CAPTCHA — which matters, because a CAPTCHA on a small
 * business contact form deters real customers at a measurable rate.
 */
export function ContactForm({
  id = 'contact', eyebrow, title, lede, subjects = [],
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  subjects?: string[];
}) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('company_website')) return; // honeypot filled — silently drop
    setStatus('sending');
    try {
      await api.contact({
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        message: String(form.get('message') ?? ''),
        subject: String(form.get('subject') ?? '') || undefined,
      });
      setStatus('sent');
      setMessage('Thanks — we have your message and will reply by email.');
    } catch {
      setStatus('error');
      setMessage('That did not send. Please try again, or email us directly.');
    }
  }

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <div className="contact-grid">
        <div className="stack">
          <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
          <ul className="contact-direct">
            <li><a href={`mailto:${site.contact.email}`}>{site.contact.email}</a></li>
            {site.contact.phone && <li><a href={`tel:${site.contact.phone.replace(/\s/g, '')}`}>{site.contact.phone}</a></li>}
            {site.contact.address && <li>{site.contact.address}</li>}
          </ul>
        </div>

        <form className="contact-form card" onSubmit={onSubmit} noValidate={false}>
          <div className="field">
            <label htmlFor="cf-name">Name</label>
            <input id="cf-name" name="name" type="text" required autoComplete="name" />
          </div>
          <div className="field">
            <label htmlFor="cf-email">Email</label>
            <input id="cf-email" name="email" type="email" required autoComplete="email" />
          </div>
          {subjects.length > 0 && (
            <div className="field">
              <label htmlFor="cf-subject">Subject</label>
              <select id="cf-subject" name="subject">
                {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="cf-message">Message</label>
            <textarea id="cf-message" name="message" rows={5} required />
          </div>

          {/* Honeypot. Hidden from people, reachable by naive bots. */}
          <div className="honeypot" aria-hidden="true">
            <label htmlFor="cf-company-website">Company website</label>
            <input id="cf-company-website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <Button variant="primary">{status === 'sending' ? 'Sending…' : 'Send message'}</Button>

          {/* aria-live so the outcome is announced, not just shown. */}
          <p className="form-status" role="status" aria-live="polite">{message}</p>
        </form>
      </div>

      <style>{`
        .contact-grid { display: grid; gap: clamp(2rem, 5vw, 4rem); grid-template-columns: 1fr; }
        @media (min-width: 60rem) { .contact-grid { grid-template-columns: 1fr 1.1fr; } }
        .contact-direct { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
        .contact-direct a { color: var(--ink); }
        .contact-form { display: grid; gap: 1rem; }
        .field { display: grid; gap: 0.35rem; }
        .field label {
          font-family: var(--font-utility); font-size: var(--fs-xs);
          letter-spacing: var(--utility-tracking); text-transform: uppercase; color: var(--ink-muted);
        }
        .field input, .field textarea, .field select {
          font: inherit; color: var(--ink); background: var(--bg);
          border: var(--border-weight) solid var(--rule); border-radius: var(--radius);
          padding: 0.7rem 0.85rem;
        }
        .field input:focus-visible, .field textarea:focus-visible, .field select:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 2px;
        }
        .honeypot { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
        .form-status { font-size: var(--fs-sm); color: var(--ink-muted); min-block-size: 1.4em; }
      `}</style>
    </Section>
  );
}
