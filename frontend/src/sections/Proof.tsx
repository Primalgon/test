import { Section, SectionHead } from './shared';

/**
 * Testimonials and case results.
 *
 * Renders nothing at all when the brief supplies no quotes. That is deliberate
 * and it is the most important line in the file: an invented testimonial is a
 * fabricated endorsement from a named person, which is the one failure mode here
 * that is not merely embarrassing but actionable. Empty beats invented.
 *
 * Attribution is required alongside the quote for the same reason — an
 * unattributed testimonial is indistinguishable from one the generator wrote.
 */
export function Proof({
  id = 'proof', eyebrow, title, lede, quotes,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  quotes: Array<{ quote: string; author: string; role?: string; company?: string }>;
}) {
  if (!quotes.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <ul className="grid-auto proof-list">
        {quotes.map((q) => (
          <li key={q.quote.slice(0, 40)} className="card proof-card">
            <figure className="proof-figure">
              <blockquote className="proof-quote"><p>{q.quote}</p></blockquote>
              <figcaption className="proof-attrib">
                <span className="proof-author">{q.author}</span>
                {(q.role || q.company) && (
                  <span className="proof-role">
                    {[q.role, q.company].filter(Boolean).join(', ')}
                  </span>
                )}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      <style>{`
        .proof-list { list-style: none; margin: 0; padding: 0; }
        .proof-figure { margin: 0; display: flex; flex-direction: column; gap: 1.25rem; height: 100%; }
        .proof-quote { margin: 0; font-size: var(--fs-md); }
        .proof-quote p { margin: 0; }
        .proof-attrib { display: flex; flex-direction: column; gap: 0.15rem; margin-block-start: auto; }
        .proof-author { font-family: var(--font-utility); font-size: var(--fs-sm); letter-spacing: var(--utility-tracking); }
        .proof-role { font-size: var(--fs-sm); color: var(--ink-muted); }
      `}</style>
    </Section>
  );
}
