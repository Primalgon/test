import { useState } from 'react';
import { Section, SectionHead } from './shared';
import { protectedImageUrl } from '../lib/protect';

/**
 * Image gallery.
 *
 * Every src goes through protectedImageUrl(), which caps the served size and
 * routes through the media endpoint rather than linking the original. That
 * single indirection does more for a photographer client than any right-click
 * handler: what a visitor can take is a display copy, not the master file.
 *
 * The lightbox is a native <dialog> — focus trapping, Escape to close, and
 * inertness of the page behind it are all handled by the platform. A div-based
 * modal has to reimplement all three and usually gets focus return wrong.
 */
export function Gallery({
  id = 'gallery', eyebrow, title, lede, images, columns = 3,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  columns?: 2 | 3 | 4;
  images: Array<{ key: string; alt: string; caption?: string }>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;

  const active = open === null ? null : images[open];

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />

      <ul className="gallery-grid" style={{ '--cols': columns } as React.CSSProperties}>
        {images.map((img, i) => (
          <li key={img.key}>
            <button
              type="button" className="gallery-item" onClick={() => setOpen(i)}
              aria-label={`View larger: ${img.alt}`}
            >
              <img
                src={protectedImageUrl(img.key, { width: 800 })}
                alt={img.alt} loading="lazy" decoding="async"
                width={800} height={600}
                data-protect="image"
              />
            </button>
            {img.caption && <p className="gallery-caption">{img.caption}</p>}
          </li>
        ))}
      </ul>

      {active && (
        <dialog className="gallery-dialog" open onClose={() => setOpen(null)}>
          <button
            type="button" className="gallery-close" onClick={() => setOpen(null)}
            aria-label="Close image viewer"
          >×</button>
          <img
            src={protectedImageUrl(active.key, { width: 1600 })}
            alt={active.alt} data-protect="image"
          />
          {active.caption && <p className="gallery-caption">{active.caption}</p>}
        </dialog>
      )}

      <style>{`
        .gallery-grid {
          list-style: none; margin: 0; padding: 0;
          display: grid; gap: clamp(0.5rem, 1.5vw, 1rem);
          grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
        }
        @media (min-width: 60rem) {
          .gallery-grid { grid-template-columns: repeat(var(--cols), 1fr); }
        }
        .gallery-item {
          display: block; inline-size: 100%; padding: 0; border: 0; cursor: zoom-in;
          background: none; border-radius: var(--radius); overflow: hidden;
        }
        .gallery-item img { display: block; inline-size: 100%; block-size: auto; aspect-ratio: 4 / 3; object-fit: cover; }
        .gallery-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
        .gallery-caption { font-size: var(--fs-sm); color: var(--ink-muted); margin-block-start: 0.5rem; }
        .gallery-dialog {
          position: fixed; inset: 0; z-index: 100;
          inline-size: min(92vw, 70rem); max-block-size: 92vh;
          background: var(--bg); border: var(--border-weight) solid var(--rule);
          border-radius: var(--radius); padding: clamp(1rem, 3vw, 2rem); color: var(--ink);
        }
        .gallery-dialog img { inline-size: 100%; block-size: auto; max-block-size: 78vh; object-fit: contain; }
        .gallery-close {
          position: absolute; inset-block-start: 0.5rem; inset-inline-end: 0.75rem;
          background: none; border: 0; color: var(--ink); font-size: var(--fs-lg); cursor: pointer;
        }
      `}</style>
    </Section>
  );
}
