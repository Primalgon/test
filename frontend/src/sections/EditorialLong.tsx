import { Section, SectionHead } from './shared';

/**
 * Long-form editorial.
 *
 * Paragraphs arrive as an array of plain strings, never as HTML. Accepting
 * markup here would mean either trusting brief content enough to
 * dangerouslySetInnerHTML it, or sanitising — and the production CSP enables
 * Trusted Types specifically to make the first option throw. Plain text with a
 * measure limit covers what this section is for.
 */
export function EditorialLong({
  id = 'story', eyebrow, title, lede, paragraphs, pullQuote,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  paragraphs: string[]; pullQuote?: string;
}) {
  if (!paragraphs.length) return null;
  const split = pullQuote ? Math.ceil(paragraphs.length / 2) : -1;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <div className="editorial">
        {paragraphs.map((p, i) => (
          <div key={p.slice(0, 30)}>
            <p>{p}</p>
            {i === split - 1 && pullQuote && (
              <blockquote className="pull-quote"><p>{pullQuote}</p></blockquote>
            )}
          </div>
        ))}
      </div>
      <style>{`
        .editorial { max-inline-size: var(--measure); display: grid; gap: 1.25rem; }
        .editorial p { font-size: var(--fs-base); }
        .pull-quote {
          margin: clamp(1.5rem, 4vw, 2.5rem) 0;
          padding-inline-start: clamp(1rem, 3vw, 2rem);
          border-inline-start: 3px solid var(--accent);
          font-family: var(--font-display); font-size: var(--fs-md);
          letter-spacing: var(--display-tracking); line-height: 1.25;
        }
        .pull-quote p { margin: 0; font-size: inherit; }
      `}</style>
    </Section>
  );
}
