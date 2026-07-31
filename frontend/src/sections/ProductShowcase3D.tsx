import { ThreeStage } from '../three/ThreeStage';
import { getAsset } from '../lib/manifest';
import { Section, SectionHead, Button } from './shared';

/**
 * A single product or subject, given room.
 *
 * Alternates the model and copy across instances via `flip` so a page with two
 * showcases does not read as a repeated block. The 3D sits in a grid beside the
 * copy for the same reason the hero does — a model stacked above text reads as
 * decoration.
 */
export function ProductShowcase3D({
  id, assetKey, eyebrow, title, body, points = [], cta, flip = false,
}: {
  id: string; assetKey: string; eyebrow?: string; title: string; body: string;
  points?: string[];
  cta?: { label: string; href: string };
  flip?: boolean;
}) {
  const asset = getAsset(assetKey);

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <div className={`showcase-grid ${flip ? 'showcase-flip' : ''}`}>
        <div className="showcase-copy stack">
          <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={body} />
          {points.length > 0 && (
            <ul className="showcase-points">
              {points.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {cta && <div><Button href={cta.href}>{cta.label}</Button></div>}
        </div>

        <div className="showcase-stage">
          {asset && (
            <ThreeStage
              assets={[asset]}
              posterSrc={asset.poster}
              alt={asset.alt}
              aspect="1 / 1"
              cameraPosition={[0, 0.1, 3.2]}
              fov={36}
            />
          )}
        </div>
      </div>
      <style>{`
        .showcase-grid {
          display: grid; gap: clamp(2rem, 5vw, 4rem);
          align-items: center; grid-template-columns: 1fr;
        }
        @media (min-width: 60rem) {
          .showcase-grid { grid-template-columns: 1fr 1fr; }
          .showcase-flip .showcase-copy { order: 2; }
        }
        .showcase-points { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
        .showcase-points li {
          padding-inline-start: 1.25rem; position: relative; color: var(--ink-muted);
        }
        .showcase-points li::before {
          content: ""; position: absolute; inset-inline-start: 0; inset-block-start: 0.6em;
          inline-size: 0.5rem; block-size: 1px; background: var(--accent);
        }
      `}</style>
    </Section>
  );
}
