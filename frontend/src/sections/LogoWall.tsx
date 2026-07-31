import { Section, SectionHead } from './shared';

/**
 * Client or partner logos.
 *
 * Only render logos the brief actually supplies. A wall of well-known marks the
 * client does not work with is a false association, and unlike most copy
 * mistakes it is one the named companies can act on.
 *
 * Each logo carries the company name as alt text rather than "logo" — a screen
 * reader announcing "logo, logo, logo" conveys nothing.
 */
export function LogoWall({
  id = 'clients', eyebrow, title, logos, note,
}: {
  id?: string; eyebrow?: string; title: string; note?: string;
  logos: Array<{ name: string; src: string; href?: string }>;
}) {
  if (!logos.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={note} />
      <ul className="logo-wall">
        {logos.map((l) => {
          const img = (
            <img src={l.src} alt={l.name} loading="lazy" decoding="async" width={200} height={80} />
          );
          return (
            <li key={l.name} className="logo-item">
              {l.href ? <a href={l.href} rel="noopener noreferrer" target="_blank">{img}</a> : img}
            </li>
          );
        })}
      </ul>
      <style>{`
        .logo-wall {
          list-style: none; margin: 0; padding: 0;
          display: grid; gap: clamp(1.5rem, 4vw, 3rem); align-items: center;
          grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
        }
        .logo-item img {
          inline-size: 100%; block-size: auto; max-block-size: 2.5rem;
          object-fit: contain; opacity: 0.72;
          filter: grayscale(1);
          transition: opacity var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out);
        }
        .logo-item:hover img { opacity: 1; filter: grayscale(0); }
        @media (prefers-reduced-motion: reduce) { .logo-item img { transition: none; } }
      `}</style>
    </Section>
  );
}
