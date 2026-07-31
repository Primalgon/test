import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiRequestError } from '../lib/api';
import { AuthStyles } from './Login';

interface Me {
  id: string;
  email: string;
  name: string | null;
  role: string;
  email_verified: boolean;
}

/**
 * The member's own account. Identity comes from GET /api/auth/me; the
 * subscription is changed or cancelled through POST /api/billing-portal,
 * which redirects into Stripe's hosted billing portal — the server never
 * lets this page state an amount, and this page never asks it to.
 */
export default function Account() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalNote, setPortalNote] = useState('');

  useEffect(() => {
    let alive = true;
    api.auth.me()
      .then((res) => {
        if (!alive) return;
        if (!res.authenticated || !res.user) {
          navigate('/login');
          return;
        }
        setMe(res.user);
        setChecking(false);
      })
      .catch(() => { if (alive) navigate('/login'); });
    return () => { alive = false; };
  }, [navigate]);

  async function openBillingPortal() {
    setPortalBusy(true);
    setPortalNote('');
    try {
      const { url } = await api.billingPortal();
      window.location.assign(url);
    } catch (err) {
      setPortalBusy(false);
      if (err instanceof ApiRequestError && err.status === 404) {
        setPortalNote('No subscription on this account yet — pick a plan to get started.');
      } else {
        setPortalNote('Could not open the billing portal. Try again in a moment.');
      }
    }
  }

  async function signOut() {
    try { await api.auth.logout(); } finally { navigate('/'); }
  }

  // One h1, shared by both render states, so the page always has exactly one.
  const heading = <h1 id="account-heading">Your account</h1>;

  if (checking) {
    return (
      <section className="section shell auth-layout" aria-busy="true" aria-labelledby="account-heading">
        <div className="stack auth-card card">
          {heading}
          <p className="auth-lede" role="status">Checking your session…</p>
        </div>
        <AuthStyles />
      </section>
    );
  }

  return (
    <section className="section shell auth-layout" aria-labelledby="account-heading">
      <div className="stack auth-card card">
        <p className="eyebrow">Members</p>
        {heading}

        <dl className="account-details">
          {me?.name && (<><dt>Name</dt><dd>{me.name}</dd></>)}
          <dt>Email</dt>
          <dd>
            {me?.email}
            {!me?.email_verified && <span className="field-hint"> (not verified yet — check your inbox)</span>}
          </dd>
        </dl>

        <div className="stack account-actions">
          <button
            type="button" className="button button-primary"
            onClick={openBillingPortal} disabled={portalBusy}
          >
            {portalBusy ? 'Opening…' : 'Manage subscription & billing'}
          </button>
          {portalNote && (
            <p className="form-notice" role="status">
              {portalNote}{' '}
              {portalNote.includes('pick a plan') && <Link to="/#plans">See the plans</Link>}
            </p>
          )}
          <p className="auth-lede">
            Change your plan, update the card, download invoices, or cancel — cancelling keeps
            your access until the end of the billing period.
          </p>
          <button type="button" className="link-button" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <style>{`
        .account-details { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 1.25rem; margin: 0; }
        .account-details dt {
          font-family: var(--font-utility); font-size: var(--fs-xs);
          letter-spacing: var(--utility-tracking); text-transform: var(--utility-case);
          color: var(--ink-muted); align-self: center;
        }
        .account-details dd { margin: 0; overflow-wrap: anywhere; }
        .account-actions { margin-block-start: 0.5rem; }
        .account-actions .button { justify-self: start; }
      `}</style>
      <AuthStyles />
    </section>
  );
}
