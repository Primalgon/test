import { Section, SectionHead } from './shared';

/**
 * FAQ.
 *
 * Native <details>/<summary> rather than a custom accordion. It is keyboard
 * accessible, screen-reader correct, and findable by in-page search without a
 * line of JavaScript — three things a hand-rolled accordion usually gets wrong.
 *
 * Emits FAQPage JSON-LD, which is what makes these eligible to appear as
 * expandable results in search. The structured data is generated from the same
 * array that renders, so the two cannot drift apart.
 */
export function Faq({
  id = 'faq', eyebrow, title, lede, items,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  items: Array<{ q: string; a: string }>;
}) {
  if (!items.length) return null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  };

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <div className="faq-list">
        {items.map((item) => (
          <details key={item.q} className="faq-item">
            <summary className="faq-q">{item.q}</summary>
            <div className="faq-a"><p>{item.a}</p></div>
          </details>
        ))}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <style>{`
        .faq-list { display: grid; }
        .faq-item { border-block-end: var(--border-weight) solid var(--rule); }
        .faq-item:first-child { border-block-start: var(--border-weight) solid var(--rule); }
        .faq-q {
          cursor: pointer; padding-block: clamp(1rem, 2.5vw, 1.5rem);
          font-family: var(--font-display); font-size: var(--fs-md);
          letter-spacing: var(--display-tracking);
          display: flex; justify-content: space-between; gap: 1rem; align-items: center;
        }
        .faq-q::-webkit-details-marker { display: none; }
        .faq-q::after {
          content: "+"; font-family: var(--font-utility); color: var(--accent); flex: none;
        }
        .faq-item[open] .faq-q::after { content: "−"; }
        .faq-a { padding-block-end: clamp(1rem, 2.5vw, 1.5rem); color: var(--ink-muted); }
        .faq-a p { margin: 0; }
        .faq-q:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
      `}</style>
    </Section>
  );
}
