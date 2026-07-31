import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../lib/api';
import { AuthStyles } from './Login';

/**
 * Registration, wired to POST /api/auth/register via the typed client.
 * The server owns password policy (12+ characters, breach-checked) and sends
 * a verification email; the success state here mirrors that flow rather than
 * pretending the account is instantly live.
 */
export default function Signup() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');

    const data = new FormData(e.currentTarget);
    try {
      const res = await api.auth.register({
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
        name: String(data.get('name') ?? '') || undefined,
      });
      setDone(res.message);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrors(err.fieldErrors);
        if (!Object.keys(err.fieldErrors).length) setFormError(err.message);
      } else {
        setFormError('Could not create the account. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  }

  // One h1, shared by both render states, so the page always has exactly one.
  const heading = (
    <h1 id="signup-heading">{done ? 'Almost there' : 'Create your account'}</h1>
  );

  if (done) {
    return (
      <section className="section shell auth-layout" aria-live="polite" aria-labelledby="signup-heading">
        <div className="stack auth-card card">
          {heading}
          <p>{done}</p>
          <p className="auth-alt">Already confirmed? <Link to="/login">Sign in</Link></p>
        </div>
        <AuthStyles />
      </section>
    );
  }

  return (
    <section className="section shell auth-layout" aria-labelledby="signup-heading">
      <div className="stack auth-card card">
        <p className="eyebrow">Start watching</p>
        {heading}
        <p className="auth-lede">One account, every screen you own. Pick a plan after you confirm your email.</p>

        <form onSubmit={onSubmit} noValidate className="stack auth-form">
          {formError && <p className="form-error" role="alert">{formError}</p>}

          <label className="field">
            <span className="field-label">Name</span>
            <input
              name="name" type="text" autoComplete="name"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'name-error' : undefined}
            />
            {errors.name && <span id="name-error" className="field-error" role="alert">{errors.name}</span>}
          </label>

          <label className="field">
            <span className="field-label">Email</span>
            <input
              name="email" type="email" required autoComplete="email"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
            />
            {errors.email && <span id="email-error" className="field-error" role="alert">{errors.email}</span>}
          </label>

          <label className="field">
            <span className="field-label">Password</span>
            <input
              name="password" type="password" required minLength={12} autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : 'password-hint'}
            />
            {errors.password
              ? <span id="password-error" className="field-error" role="alert">{errors.password}</span>
              : <span id="password-hint" className="field-hint">At least 12 characters. Length beats symbols.</span>}
          </label>

          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="auth-alt">Already a member? <Link to="/login">Sign in</Link></p>
      </div>
      <AuthStyles />
    </section>
  );
}
