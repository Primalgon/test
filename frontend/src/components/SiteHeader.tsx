import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { site } from '../site.config';
import { api } from '../lib/api';

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  // Header reflects whether someone is signed in: "Sign in" for visitors,
  // "Account" for members. Session state comes from the server (GET
  // /api/auth/me reads the __Host- cookie); nothing is stored client-side.
  useEffect(() => {
    let alive = true;
    api.auth.me()
      .then((res) => { if (alive) setAuthed(res.authenticated); })
      .catch(() => { if (alive) setAuthed(false); });
    return () => { alive = false; };
  }, [pathname]);

  const authItem = authed
    ? { label: 'Account', href: '/account' }
    : { label: 'Sign in', href: '/login' };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close on Escape and trap focus to the panel while the mobile menu is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="shell header-inner">
        <Link to="/" className="wordmark">{site.name}</Link>

        <nav className="nav-desktop" aria-label="Main">
          {site.nav.map((item) => (
            <Link key={item.href} to={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
          <Link
            to={authItem.href}
            className="nav-auth"
            aria-current={pathname === authItem.href ? 'page' : undefined}
          >
            {authItem.label}
          </Link>
        </nav>

        <button
          className="nav-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open && (
        <nav id="mobile-nav" className="nav-mobile" aria-label="Main">
          {site.nav.map((item) => (
            <Link key={item.href} to={item.href}>{item.label}</Link>
          ))}
          <Link to={authItem.href}>{authItem.label}</Link>
        </nav>
      )}

      <style>{`
        .site-header {
          position: sticky; top: 0; z-index: 50;
          background: color-mix(in oklab, var(--bg) 88%, transparent);
          backdrop-filter: blur(12px);
          border-bottom: var(--border-weight) solid transparent;
          transition: border-color var(--dur-fast) var(--ease-out);
        }
        .site-header[data-scrolled='true'] { border-bottom-color: var(--rule); }

        .header-inner {
          display: flex; align-items: center; justify-content: space-between;
          gap: 1.5rem; min-height: 4.25rem;
        }

        .wordmark {
          font-family: var(--font-display);
          font-weight: var(--display-weight);
          letter-spacing: var(--display-tracking);
          text-transform: var(--display-case);
          font-size: var(--fs-md);
          text-decoration: none;
        }

        .nav-desktop { display: none; gap: 2rem; }
        .nav-desktop a {
          font-family: var(--font-utility);
          font-size: var(--fs-sm);
          letter-spacing: var(--utility-tracking);
          text-transform: var(--utility-case);
          text-decoration: none;
          color: var(--ink-muted);
          transition: color var(--dur-fast) var(--ease-out);
        }
        .nav-desktop a:hover, .nav-desktop a[aria-current='page'] { color: var(--ink); }
        .nav-desktop .nav-auth {
          color: var(--ink);
          border: 1px solid var(--rule); border-radius: var(--radius);
          padding: 0.45rem 0.9rem;
        }
        .nav-desktop .nav-auth:hover { border-color: var(--accent); }

        .nav-toggle {
          background: none; border: var(--border-weight) solid var(--rule);
          color: var(--ink); border-radius: var(--radius);
          padding: 0.5rem 0.9rem; cursor: pointer;
          font-family: var(--font-utility); font-size: var(--fs-xs);
          letter-spacing: var(--utility-tracking); text-transform: var(--utility-case);
        }

        .nav-mobile {
          display: flex; flex-direction: column; gap: 0.25rem;
          padding: 1rem clamp(1.25rem, 5vw, 4rem) 2rem;
          border-top: var(--border-weight) solid var(--rule);
        }
        .nav-mobile a {
          padding: 0.85rem 0; text-decoration: none;
          font-family: var(--font-display); font-size: var(--fs-md);
          border-bottom: 1px solid var(--rule);
        }

        @media (min-width: 48rem) {
          .nav-desktop { display: flex; }
          .nav-toggle, .nav-mobile { display: none; }
        }
      `}</style>
    </header>
  );
}
