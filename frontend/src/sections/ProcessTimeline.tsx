import { Section, SectionHead } from './shared';

/**
 * Ordered process steps.
 *
 * An <ol> because the order carries meaning — a screen reader announcing "list
 * of 4 items" loses the sequence that is the entire point of the section.
 */
export function ProcessTimeline({
  id = 'process', eyebrow, title, lede, steps,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  steps: Array<{ title: string; body: string; duration?: string }>;
}) {
  if (!steps.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <ol className="timeline">
        {steps.map((step, i) => (
          <li key={step.title} className="timeline-step">
            <div className="timeline-marker" aria-hidden="true">
              <span className="timeline-number">{String(i + 1).padStart(2, '0')}</span>
            </div>
            <div className="stack-tight">
              <h3 className="timeline-title">{step.title}</h3>
              {step.duration && <p className="label">{step.duration}</p>}
              <p className="timeline-body">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <style>{`
        .timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
        .timeline-step {
          display: grid; grid-template-columns: auto 1fr;
          gap: clamp(1rem, 3vw, 2rem);
          padding-block: clamp(1.5rem, 3vw, 2.25rem);
          border-block-end: var(--border-weight) solid var(--rule);
        }
        .timeline-step:first-child { border-block-start: var(--border-weight) solid var(--rule); }
        .timeline-marker { display: flex; align-items: flex-start; }
        .timeline-number {
          font-family: var(--font-utility); font-size: var(--fs-sm);
          letter-spacing: var(--utility-tracking); color: var(--accent);
        }
        .timeline-title { font-size: var(--fs-md); }
        .timeline-body { color: var(--ink-muted); }
      `}</style>
    </Section>
  );
}
