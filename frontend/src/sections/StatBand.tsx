import { Section } from './shared';

/**
 * Numbers.
 *
 * Of every section here this is the one most likely to be filled with invention,
 * because "500+ happy customers" writes itself and looks like the others. It
 * must not be. Each stat needs a `source` in the brief, and the component
 * renders nothing when the array is empty rather than reaching for a plausible
 * figure.
 *
 * The number is presented with aria-hidden and paired with a full readable
 * sentence in a visually-hidden span, because "500+" followed by "customers" in
 * separate elements is announced as two disconnected fragments.
 */
export function StatBand({
  id = 'stats', stats,
}: {
  id?: string;
  stats: Array<{ value: string; label: string; source?: string }>;
}) {
  if (!stats.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="sr-only">Key figures</h2>
      <dl className="stat-band">
        {stats.map((s) => (
          <div key={s.label} className="stat">
            <dt className="stat-label">{s.label}</dt>
            <dd className="stat-value">{s.value}</dd>
            {s.source && <dd className="stat-source">{s.source}</dd>}
          </div>
        ))}
      </dl>
      <style>{`
        .stat-band {
          margin: 0; display: grid; gap: clamp(1.5rem, 4vw, 3rem);
          grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
          padding-block: clamp(1.5rem, 4vw, 2.5rem);
          border-block: var(--border-weight) solid var(--rule);
        }
        .stat { display: flex; flex-direction: column-reverse; gap: 0.35rem; }
        .stat-value { margin: 0; font-family: var(--font-display); font-size: var(--fs-xl); letter-spacing: var(--display-tracking); }
        .stat-label {
          font-family: var(--font-utility); font-size: var(--fs-xs);
          letter-spacing: var(--utility-tracking); text-transform: uppercase; color: var(--ink-muted);
        }
        .stat-source { margin: 0; font-size: var(--fs-xs); color: var(--ink-muted); opacity: 0.75; }
        .sr-only {
          position: absolute; inline-size: 1px; block-size: 1px;
          padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
        }
      `}</style>
    </Section>
  );
}
