import { Section, SectionHead, Button } from './shared';
import { useProducts, formatPrice, startCheckout } from '../lib/commerce';

/**
 * Pricing.
 *
 * Prices come from useProducts(), which reads the server's products table. There
 * is no prop for passing a price in, and that omission is the point — if this
 * component accepted `price` it would be used, and a price in the bundle is a
 * price the visitor edits in devtools before checkout.
 *
 * `highlight` names a product sku rather than an index so that reordering the
 * table in the admin dashboard does not silently move the emphasis to a
 * different plan. The sku is the stable id the brief knows; row ids are
 * generated at seed time.
 */
export function Pricing({
  id = 'pricing', eyebrow, title, lede, highlight, ctaLabel = 'Choose',
}: {
  id?: string; eyebrow?: string; title: string; lede?: string;
  highlight?: string; ctaLabel?: string;
}) {
  const { products, loading, error } = useProducts();

  return (
    <Section id={id} labelledBy={`${id}-heading`}>
      <SectionHead id={`${id}-heading`} eyebrow={eyebrow} title={title} lede={lede} />

      {loading && <p className="pricing-state" role="status">Loading pricing…</p>}
      {error && <p className="pricing-state" role="status">{error}</p>}

      {!loading && !error && (
        <ul className="grid-auto pricing-list">
          {products.map((p) => (
            <li
              key={p.id}
              className={`card pricing-card ${p.sku === highlight ? 'pricing-featured' : ''}`}
            >
              {p.sku === highlight && <p className="label pricing-flag">Most chosen</p>}
              <h3 className="pricing-name">{p.name}</h3>
              <p className="pricing-amount">
                {formatPrice(p.amount_cents, p.currency)}
                {p.recurring !== 'none' && <span className="pricing-period"> / {p.recurring}</span>}
              </p>
              {p.description && <p className="pricing-desc">{p.description}</p>}
              <div className="pricing-action">
                <Button
                  variant={p.sku === highlight ? 'primary' : 'quiet'}
                  onClick={() => startCheckout([{ sku: p.sku, quantity: 1 }])}
                  ariaLabel={`${ctaLabel} ${p.name}`}
                >
                  {ctaLabel}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .pricing-list { list-style: none; margin: 0; padding: 0; }
        .pricing-card { display: flex; flex-direction: column; gap: 0.75rem; }
        .pricing-featured { border-color: var(--accent); }
        .pricing-flag { color: var(--accent); }
        .pricing-name { font-size: var(--fs-md); }
        .pricing-amount { font-family: var(--font-utility); font-size: var(--fs-lg); }
        .pricing-period { font-size: var(--fs-sm); color: var(--ink-muted); }
        .pricing-desc { color: var(--ink-muted); }
        .pricing-action { margin-block-start: auto; padding-block-start: 1rem; }
        .pricing-state { color: var(--ink-muted); }
      `}</style>
    </Section>
  );
}
