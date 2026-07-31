import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiRequestError } from '../lib/api';

/**
 * Sign in, wired to the existing backend session routes — POST /api/auth/login
 * and POST /api/auth/forgot-password via the typed client in lib/api.ts.
 * No password or token ever touches storage here: the server sets a
 * __Host- session cookie, and the client only forwards credentials once.
 */
export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    setNotice('');

    const data = new FormData(e.currentTarget);
    const email = String(data.get('email') ?? '');

    try {
      if (mode === 'reset') {
        const res = await api.auth.forgotPassword(email);
        setNotice(res.message);
      } else {
        await api.auth.login(email, String(data.get('password') ?? ''));
        navigate('/account');
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrors(err.fieldErrors);
        if (!Object.keys(err.fieldErrors).length) setFormError(err.message);
      } else {
        setFormError('Could not sign you in. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section shell auth-layout" aria-labelledby="login-heading">
      <div className="stack auth-card card">
        <p className="eyebrow">{mode === 'reset' ? 'Reset password' : 'Members'}</p>
        <h1 id="login-heading">{mode === 'reset' ? 'Reset your password' : 'Sign in'}</h1>
        <p className="auth-lede">
          {mode === 'reset'
            ? 'Enter your email and we will send a reset link.'
            : 'Pick up right where you left off.'}
        </p>

        <form onSubmit={onSubmit} noValidate className="stack auth-form">
          {formError && <p className="form-error" role="alert">{formError}</p>}
          {notice && <p className="form-notice" role="status">{notice}</p>}

          <label className="field">
            <span className="field-label">Email</span>
            <input
              name="email" type="email" required autoComplete="email"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
            />
            {errors.email && <span id="email-error" className="field-error" role="alert">{errors.email}</span>}
          </label>

          {mode === 'login' && (
            <label className="field">
              <span className="field-label">Password</span>
              <input
                name="password" type="password" required autoComplete="current-password"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : undefined}
              />
              {errors.password && <span id="password-error" className="field-error" role="alert">{errors.password}</span>}
            </label>
          )}

          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'One moment…' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
          </button>
        </form>

        <p className="auth-alt">
          {mode === 'login' ? (
            <>
              <button type="button" className="link-button" onClick={() => setMode('reset')}>
                Forgot your password?
              </button>
              {' · '}
              New here? <Link to="/signup">Create your account</Link>
            </>
          ) : (
            <button type="button" className="link-button" onClick={() => setMode('login')}>
              Back to sign in
            </button>
          )}
        </p>
      </div>
      <AuthStyles />
    </section>
  );
}

/** Shared styling for the small auth pages; tokens only, no literals. */
export function AuthStyles() {
  return (
    <style>{`
      .auth-layout { display: grid; justify-items: center; }
      .auth-card { inline-size: min(100%, 28rem); }
      .auth-lede { color: var(--ink-muted); }
      .auth-form { margin-block-start: 0.5rem; }
      .field { display: block; }
      .field-label {
        display: block; font-family: var(--font-utility); font-size: var(--fs-xs);
        letter-spacing: var(--utility-tracking); text-transform: var(--utility-case);
        color: var(--ink-muted); margin-block-end: 0.4rem;
      }
      .field input {
        width: 100%; padding: 0.8rem 1rem;
        background: var(--bg); color: var(--ink);
        border: 1px solid var(--rule); border-radius: var(--radius);
        font: inherit; font-size: var(--fs-base);
      }
      .field input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .field-error, .form-error {
        display: block; color: var(--signal); font-size: var(--fs-sm);
        margin-block-start: 0.35rem;
      }
      .form-notice { color: var(--ink-muted); font-size: var(--fs-sm); }
      .field-hint { color: var(--ink-muted); font-size: var(--fs-xs); margin-block-start: 0.35rem; display: block; }
      .auth-alt { font-size: var(--fs-sm); color: var(--ink-muted); }
      .auth-alt a { color: var(--ink); }
      .link-button {
        background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
        color: var(--ink); text-decoration: underline; text-underline-offset: 0.2em;
      }
      .link-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .button[disabled] { opacity: 0.6; cursor: progress; }
    `}</style>
  );
}
