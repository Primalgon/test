import { Link } from 'react-router';
import { site } from '../site.config';
import { forceQuality, detectQuality } from '../three/quality';
import { useState } from 'react';

export function SiteFooter() {
  const [motionOff, setMotionOff] = useState(() => detectQuality().tier === 'off');

  /**
   * A visible control to turn off the 3D. prefers-reduced-motion covers people
   * who have set it at the OS level; this covers everyone else who simply wants
   * the page to stop moving, and costs one line to offer.
   */
  const toggleMotion = () => {
    const next = !motionOff;
    forceQuality(next ? 'off' : 'medium');
    setMotionOff(next);
  };

  return (
    <footer className="site-footer">
      <hr className="rule" />
      <div className="shell footer-inner">
        <div className="footer-brand">
          <p className="wordmark-sm">{site.name}</p>
          <p className="footer-tagline">{site.tagline}</p>
        </div>

        <nav className="footer-nav" aria-label="Footer">
          {site.nav.map((i) => <Link key={i.href} to={i.href}>{i.label}</Link>)}
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>

        <div className="footer-contact">
          <a href={`mailto:${site.contact.email}`}>{site.contact.email}</a>
          {site.contact.phone && <a href={`tel:${site.contact.phone}`}>{site.contact.phone}</a>}
          <button className="motion-toggle" onClick={toggleMotion} aria-pressed={motionOff}>
            {motionOff ? 'Turn animation on' : 'Turn animation off'}
          </button>
        </div>
      </div>

      <div className="shell footer-legal">
        <p>&copy; {new Date().getFullYear()} {site.name}. All rights reserved.</p>
      </div>

      <style>{`
        .site-footer { margin-block-start: var(--section-y); }
        .footer-inner {
          display: grid; gap: 2.5rem;
          padding-block: clamp(3rem, 6vw, 4.5rem);
          grid-template-columns: 1fr;
        }
        @media (min-width: 48rem) {
          .footer-inner { grid-template-columns: 1.4fr 1fr 1fr; }
        }
        .wordmark-sm {
          font-family: var(--font-display); font-size: var(--fs-md);
          letter-spacing: var(--display-tracking); text-transform: var(--display-case);
        }
        .footer-tagline { color: var(--ink-muted); font-size: var(--fs-sm); max-width: 32ch; margin-block-start: 0.5rem; }
        .footer-nav, .footer-contact { display: flex; flex-direction: column; gap: 0.6rem; align-items: start; }
        .footer-nav a, .footer-contact a, .motion-toggle {
          font-family: var(--font-utility); font-size: var(--fs-sm);
          color: var(--ink-muted); text-decoration: none;
        }
        .footer-nav a:hover, .footer-contact a:hover { color: var(--ink); }
        .motion-toggle {
          background: none; border: 0; padding: 0; cursor: pointer;
          text-align: left; text-decoration: underline; text-underline-offset: 0.2em;
        }
        .footer-legal { padding-block-end: 3rem; }
        .footer-legal p { font-size: var(--fs-xs); color: var(--ink-muted); }
      `}</style>
    </footer>
  );
}
