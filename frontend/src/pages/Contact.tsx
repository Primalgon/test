import { useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '../lib/api';
import { site } from '../site.config';

type Status = 'idle' | 'sending' | 'sent';

/**
 * Contact form. Three things here that generated forms usually miss:
 *   - errors land on the field that caused them, from the API's `details`
 *   - the honeypot is visually hidden but not display:none (bots skip those)
 *   - the success state replaces the form rather than sitting above it, so
 *     nobody submits twice
 */
export default function Contact() {
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setErrors({});
    setFormError('');

    const data = new FormData(e.currentTarget);
    try {
      await api.contact({
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        message: String(data.get('message') ?? ''),
        subject: String(data.get('subject') ?? '') || undefined,
      });
      setStatus('sent');
    } catch (err) {
      setStatus('idle');
      if (err instanceof ApiRequestError) {
        setErrors(err.fieldErrors);
        if (!Object.keys(err.fieldErrors).length) setFormError(err.message);
      } else {
        setFormError('Could not send that. Try again in a moment.');
      }
    }
  }

  // One h1, shared by both render states, so the page always has exactly one.
  const heading = (
    <h1 id="contact-heading">{status === 'sent' ? 'Message sent' : 'How to reach us'}</h1>
  );

  if (status === 'sent') {
    return (
      <section className="section shell stack" aria-live="polite" aria-labelledby="contact-heading">
        {heading}
        <p>Thanks — your message is on its way. We will reply to the address you gave us.</p>
        <p><a href="/">Back to the homepage</a></p>
      </section>
    );
  }

  return (
    <section className="section shell contact-layout" aria-labelledby="contact-heading">
      <div className="stack">
        <p className="eyebrow">Contact</p>
        {heading}
        <p>
          Questions about your account, a plan, or billing — write to us here, or email{' '}
          <a href={`mailto:${site.contact.email}`}>{site.contact.email}</a>.
          Plan changes and cancellations are self-serve from{' '}
          <a href="/account">your account</a>.
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="contact-form stack">
        {formError && <p className="form-error" role="alert">{formError}</p>}

        <Field name="name" label="Your name" error={errors.name} required autoComplete="name" />
        <Field name="email" label="Email" type="email" error={errors.email} required autoComplete="email" />
        <Field name="subject" label="Subject" error={errors.subject} />

        <label className="field">
          <span className="field-label">Message</span>
          <textarea
            name="message" rows={6} required minLength={10}
            aria-invalid={!!errors.message}
            aria-describedby={errors.message ? 'message-error' : undefined}
          />
          {errors.message && <span id="message-error" className="field-error" role="alert">{errors.message}</span>}
        </label>

        {/* Honeypot: off-screen, not display:none, and unlabelled for humans. */}
        <div className="visually-hidden" aria-hidden="true">
          <label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label>
        </div>

        <button type="submit" className="button button-primary" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send message'}
        </button>
      </form>

      <style>{`
        .contact-layout { display: grid; gap: clamp(2rem, 5vw, 4rem); align-items: start; }
        @media (min-width: 60rem) { .contact-layout { grid-template-columns: 1fr 1.1fr; } }
        .field { display: block; }
        .field-label {
          display: block; font-family: var(--font-utility); font-size: var(--fs-xs);
          letter-spacing: var(--utility-tracking); text-transform: var(--utility-case);
          color: var(--ink-muted); margin-block-end: 0.4rem;
        }
        .field input, .field textarea {
          width: 100%; padding: 0.8rem 1rem;
          background: var(--bg-raised); color: var(--ink);
          border: 1px solid var(--rule); border-radius: var(--radius);
          font: inherit; font-size: var(--fs-base);
        }
        .field input:focus-visible, .field textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .field-error, .form-error {
          display: block; color: var(--signal); font-size: var(--fs-sm);
          margin-block-start: 0.35rem;
        }
        .button[disabled] { opacity: 0.6; cursor: progress; }
      `}</style>
    </section>
  );
}

function Field({ name, label, error, type = 'text', ...rest }: {
  name: string; label: string; error?: string; type?: string;
  required?: boolean; autoComplete?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        name={name} type={type} {...rest}
        aria-invalid={!!error}
        aria-describedby={error ? `${name}-error` : undefined}
      />
      {error && <span id={`${name}-error`} className="field-error" role="alert">{error}</span>}
    </label>
  );
}
