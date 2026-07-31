import type { ReactNode } from 'react';

/**
 * Shared section vocabulary.
 *
 * Every section below composes from these three primitives and the direction
 * pack's custom properties. Nothing here hardcodes a colour, a font, or a size.
 *
 * The reason this file exists at all: without it, each section reinvents its own
 * heading rhythm and button padding, and the site ends up looking like fourteen
 * templates stitched together. One vocabulary is what makes a generated site
 * read as designed rather than assembled.
 */

export function Section({
  id, labelledBy, className = '', children,
}: { id?: string; labelledBy?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={`section ${className}`} aria-labelledby={labelledBy}>
      <div className="shell stack">{children}</div>
    </section>
  );
}

/**
 * Eyebrow / heading / lede.
 *
 * `as` exists because heading level is a document-structure decision, not a
 * styling one. A section that lands on the home page under the hero needs h2;
 * the same section as the first thing on its own page needs h1. Hardcoding h2
 * here would silently break the "one h1 per page, levels not skipped" rule the
 * moment a section is reused.
 */
export function SectionHead({
  id, eyebrow, title, lede, as: Tag = 'h2', align = 'start',
}: {
  id: string; eyebrow?: string; title: string; lede?: string;
  as?: 'h1' | 'h2' | 'h3'; align?: 'start' | 'center';
}) {
  return (
    <div className={`section-head stack-tight ${align === 'center' ? 'section-head-center' : ''}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <Tag id={id} className="section-title">{title}</Tag>
      {lede && <p className="section-lede">{lede}</p>}
    </div>
  );
}

export function Button({
  href, onClick, variant = 'primary', children, ariaLabel,
}: {
  href?: string; onClick?: () => void;
  variant?: 'primary' | 'quiet'; children: ReactNode; ariaLabel?: string;
}) {
  const cls = `button button-${variant}`;
  if (href) return <a className={cls} href={href} aria-label={ariaLabel}>{children}</a>;
  return <button type="button" className={cls} onClick={onClick} aria-label={ariaLabel}>{children}</button>;
}

/**
 * Styles for the shared vocabulary. Injected once.
 *
 * Mounted from App rather than duplicated per section — fourteen copies of the
 * same rules is fourteen chances for them to drift apart.
 */
export function SectionStyles() {
  return (
    <style>{`
      .section-head { max-width: 52ch; }
      .section-head-center { margin-inline: auto; text-align: center; }
      .section-title { font-size: var(--fs-lg); }
      .section-lede { font-size: var(--fs-md); color: var(--ink-muted); }

      .button {
        display: inline-flex; align-items: center; gap: 0.5rem;
        padding: 0.85rem 1.5rem;
        border-radius: var(--radius);
        font-family: var(--font-utility);
        font-size: var(--fs-sm);
        letter-spacing: var(--utility-tracking);
        text-transform: uppercase;
        text-decoration: none;
        border: var(--border-weight) solid transparent;
        cursor: pointer;
        transition: transform var(--dur-fast) var(--ease-out);
      }
      .button-primary { background: var(--accent); color: var(--accent-ink); }
      .button-quiet { border-color: var(--rule); color: var(--ink); background: transparent; }
      .button:hover { transform: translateY(-1px); }

      .card {
        background: var(--bg-raised);
        border: var(--border-weight) solid var(--rule);
        border-radius: var(--radius);
        padding: clamp(1.25rem, 3vw, 2rem);
      }

      .grid-auto {
        display: grid;
        gap: clamp(1rem, 2.5vw, 1.75rem);
        grid-template-columns: repeat(auto-fit, minmax(min(17rem, 100%), 1fr));
      }

      /* Motion is opt-out at the OS level, not a site toggle. Every transition
         and transform in this file respects it. */
      @media (prefers-reduced-motion: reduce) {
        .button:hover { transform: none; }
        .button { transition: none; }
      }
    `}</style>
  );
}
