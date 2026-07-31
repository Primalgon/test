import { Section, SectionHead } from './shared';

/**
 * Feature / service grid.
 *
 * Items come from brief.site.pages[].content or business.differentiator, split
 * into discrete claims. If the brief supports three features, render three —
 * padding to a tidy six means inventing two, which is the failure this template
 * is built to prevent.
 */
export function FeatureGrid({
  id = 'features', eyebrow, title, lede, items, as = 'h2',
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  as?: 'h1' | 'h2';
  items: Array<{ title: string; body: string; label?: string }>;
}) {
  if (!items.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} as={as} />
      <ul className="grid-auto feature-list">
        {items.map((item) => (
          <li key={item.title} className="card feature-card">
            {item.label && <p className="label">{item.label}</p>}
            <h3 className="feature-title">{item.title}</h3>
            <p className="feature-body">{item.body}</p>
          </li>
        ))}
      </ul>
      <style>{`
        .feature-list { list-style: none; margin: 0; padding: 0; }
        .feature-card { display: flex; flex-direction: column; gap: 0.6rem; }
        .feature-title { font-size: var(--fs-md); }
        .feature-body { color: var(--ink-muted); }
      `}</style>
    </Section>
  );
}
