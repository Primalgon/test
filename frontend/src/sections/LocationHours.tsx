import { Section, SectionHead } from './shared';

const DAY_LABEL: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface Hours { day: string; open: string; close: string; note?: string }

/**
 * Address and opening hours.
 *
 * Both come from brief.business.location and neither is ever guessed. A wrong
 * closing time sends a customer to a locked door, which is worse for the client
 * than the section being absent — so when the brief has no location this
 * component renders nothing at all.
 *
 * Days the brief omits are shown as Closed rather than skipped. A list that
 * jumps Friday to Sunday leaves the visitor unsure whether Saturday is closed or
 * merely unlisted.
 *
 * Emits LocalBusiness JSON-LD, which is what populates the hours panel in map
 * and search results.
 */
export function LocationHours({
  id = 'visit', eyebrow, title, lede, name, address, hours = [], mapsUrl, phone,
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  name: string;
  address: { line1: string; line2?: string; city: string; region?: string; postal?: string; country: string };
  hours?: Hours[];
  mapsUrl?: string; phone?: string;
}) {
  const byDay = new Map(hours.map((h) => [h.day, h]));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name,
    address: {
      '@type': 'PostalAddress',
      streetAddress: [address.line1, address.line2].filter(Boolean).join(', '),
      addressLocality: address.city,
      addressRegion: address.region,
      postalCode: address.postal,
      addressCountry: address.country,
    },
    ...(phone ? { telephone: phone } : {}),
    ...(hours.length ? {
      openingHoursSpecification: hours.map((h) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${DAY_LABEL[h.day]}`,
        opens: h.open, closes: h.close,
      })),
    } : {}),
  };

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />
      <div className="visit-grid">
        <div className="stack-tight">
          <p className="label">Address</p>
          <address className="visit-address">
            {address.line1}<br />
            {address.line2 && <>{address.line2}<br /></>}
            {address.city}{address.region ? `, ${address.region}` : ''} {address.postal}<br />
            {address.country}
          </address>
          {phone && <p><a href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a></p>}
          {mapsUrl && (
            <p><a href={mapsUrl} target="_blank" rel="noopener noreferrer">Open in maps</a></p>
          )}
        </div>

        {hours.length > 0 && (
          <div className="stack-tight">
            <p className="label">Opening hours</p>
            <dl className="hours-list">
              {DAY_ORDER.map((d) => {
                const h = byDay.get(d);
                return (
                  <div key={d} className="hours-row">
                    <dt>{DAY_LABEL[d]}</dt>
                    <dd>{h ? `${h.open}–${h.close}${h.note ? ` · ${h.note}` : ''}` : 'Closed'}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <style>{`
        .visit-grid { display: grid; gap: clamp(2rem, 5vw, 3.5rem); grid-template-columns: 1fr; }
        @media (min-width: 48rem) { .visit-grid { grid-template-columns: 1fr 1fr; } }
        .visit-address { font-style: normal; color: var(--ink-muted); line-height: 1.7; }
        .hours-list { margin: 0; display: grid; gap: 0.4rem; }
        .hours-row {
          display: flex; justify-content: space-between; gap: 1rem;
          padding-block: 0.4rem; border-block-end: var(--border-weight) solid var(--rule);
        }
        .hours-row dt { color: var(--ink); }
        .hours-row dd { margin: 0; color: var(--ink-muted); font-family: var(--font-utility); font-size: var(--fs-sm); }
      `}</style>
    </Section>
  );
}
