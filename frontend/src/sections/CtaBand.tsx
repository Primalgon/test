import { Button } from './shared';
import { site } from '../site.config';

/**
 * Closing call to action.
 *
 * Takes its default label and target from site.cta, which comes from
 * brief.site.primary_cta — so the button says the same thing here as it does in
 * the hero, and changing the brief changes both.
 */
export function CtaBand({
  id = 'cta', title, sub, primary, secondary,
}: {
  id?: string; title: string; sub?: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  const main = primary ?? { label: site.cta.label, href: site.cta.target ?? '/contact' };

  return (
    <section id={id} className="section" aria-labelledby={`${id}-heading`}>
      <div className="shell cta-band">
        <div className="stack-tight">
          <h2 id={`${id}-heading`} className="cta-heading">{title}</h2>
          {sub && <p className="cta-sub">{sub}</p>}
        </div>
        <div className="cta-actions">
          <Button href={main.href}>{main.label}</Button>
          {secondary && <Button href={secondary.href} variant="quiet">{secondary.label}</Button>}
        </div>
      </div>
      <style>{`
        .cta-band {
          display: grid; gap: clamp(1.5rem, 4vw, 3rem); align-items: center;
          padding: clamp(2rem, 5vw, 3.5rem);
          background: var(--bg-raised);
          border: var(--border-weight) solid var(--rule);
          border-block-start: 3px solid var(--accent);
          border-radius: var(--radius);
        }
        @media (min-width: 60rem) { .cta-band { grid-template-columns: 1.2fr auto; } }
        .cta-heading { font-size: var(--fs-lg); }
        .cta-sub { color: var(--ink-muted); font-size: var(--fs-md); }
        .cta-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
      `}</style>
    </section>
  );
}
