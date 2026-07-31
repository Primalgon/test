import { Section, SectionHead } from './shared';

/**
 * Team.
 *
 * Photos are optional and the layout does not degrade without them — a brief
 * that lists names and roles but supplies no headshots is common, and the
 * alternative (a grid of grey silhouette placeholders) looks worse than initials.
 *
 * `loading="lazy"` and explicit dimensions on every image: without width and
 * height the page reflows as each photo arrives, which is both ugly and a
 * measurable layout-shift penalty.
 */
export function Team({
  id = 'team', eyebrow, title, lede, members,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  members: Array<{ name: string; role: string; bio?: string; photo?: string }>;
}) {
  if (!members.length) return null;

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <ul className="grid-auto team-list">
        {members.map((m) => (
          <li key={m.name} className="team-member">
            {m.photo ? (
              <img
                className="team-photo" src={m.photo} alt={`${m.name}, ${m.role}`}
                width={480} height={480} loading="lazy" decoding="async"
              />
            ) : (
              <div className="team-initials" aria-hidden="true">
                {m.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </div>
            )}
            <div className="stack-tight">
              <h3 className="team-name">{m.name}</h3>
              <p className="label">{m.role}</p>
              {m.bio && <p className="team-bio">{m.bio}</p>}
            </div>
          </li>
        ))}
      </ul>
      <style>{`
        .team-list { list-style: none; margin: 0; padding: 0; }
        .team-member { display: flex; flex-direction: column; gap: 1rem; }
        .team-photo, .team-initials {
          inline-size: 100%; aspect-ratio: 1 / 1; object-fit: cover;
          border-radius: var(--radius); border: var(--border-weight) solid var(--rule);
        }
        .team-initials {
          display: grid; place-items: center; background: var(--bg-raised);
          font-family: var(--font-display); font-size: var(--fs-lg); color: var(--ink-muted);
        }
        .team-name { font-size: var(--fs-md); }
        .team-bio { color: var(--ink-muted); font-size: var(--fs-sm); }
      `}</style>
    </Section>
  );
}
