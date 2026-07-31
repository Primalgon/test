import { ThreeStage } from '../three/ThreeStage';
import { getAsset } from '../lib/manifest';
import { site } from '../site.config';

/**
 * The hero.
 *
 * Composition rule for this template: the 3D subject and the headline share a
 * grid, they do not stack. A model dropped above a centred headline is the
 * layout every 3D site template ships with, and it reads as decoration rather
 * than as the subject of the page.
 *
 * The eyebrow carries the audience from the brief instead of a generic
 * category label, because "For independent watchmakers" tells a visitor
 * whether to keep reading and "Welcome" does not.
 */
export function Hero3D({
  headline, sub, eyebrow, as: Tag = 'h1',
}: { headline: string; sub: string; eyebrow?: string; as?: 'h1' | 'h2' }) {
  const asset = getAsset('device_array');

  return (
    <section className="section hero" aria-labelledby="hero-heading">
      <div className="shell hero-grid">
        <div className="hero-copy stack">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <Tag id="hero-heading" className="hero-headline">{headline}</Tag>
          <p className="hero-sub">{sub}</p>
          <div className="hero-actions">
            <a className="button button-primary" href={site.cta.target ?? '/contact'}>
              {site.cta.label}
            </a>
            <a className="button button-quiet" href="#plans">
              See the plans
            </a>
          </div>
        </div>

        <div className="hero-stage">
          {asset && (
            <ThreeStage
              assets={[asset]}
              posterSrc={asset.poster}
              alt={asset.alt}
              aspect="1 / 1"
              cameraPosition={[0, 0.2, 3]}
              fov={38}
            />
          )}
        </div>
      </div>

      <style>{`
        .hero { padding-block-start: clamp(3rem, 8vw, 6rem); }

        .hero-grid {
          display: grid;
          gap: clamp(2rem, 5vw, 4rem);
          align-items: center;
          grid-template-columns: 1fr;
        }
        @media (min-width: 60rem) {
          /* Copy takes the larger share. The model is the subject, not the page. */
          .hero-grid { grid-template-columns: 1.15fr 1fr; }
        }

        .hero-headline { font-size: var(--fs-display); }
        .hero-sub { font-size: var(--fs-md); color: var(--ink-muted); max-width: 34ch; }

        .hero-actions {
          display: flex; flex-wrap: wrap; gap: 0.75rem;
          margin-block-start: calc(var(--step) * 4);
        }

        .button {
          display: inline-flex; align-items: center; gap: 0.5rem;
          padding: 0.85rem 1.5rem;
          border-radius: var(--radius);
          font-family: var(--font-utility);
          font-size: var(--fs-sm);
          letter-spacing: var(--utility-tracking);
          text-transform: var(--utility-case);
          text-decoration: none;
          border: var(--border-weight) solid transparent;
          transition: transform var(--dur-fast) var(--ease-out),
                      background-color var(--dur-fast) var(--ease-out);
        }
        .button-primary { background: var(--accent); color: var(--accent-ink); }
        .button-quiet { border-color: var(--rule); color: var(--ink); }
        .button:hover { transform: translateY(-1px); }
        .button:active { transform: translateY(0); }

        @media (prefers-reduced-motion: reduce) {
          .button:hover { transform: none; }
        }
      `}</style>
    </section>
  );
}
