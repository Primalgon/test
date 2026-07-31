import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Products and prices, from the server. Always.
 *
 * This hook exists so that no generated site ever writes a price into a
 * component, and it is worth being explicit about why, because "just put $16 in
 * the JSX" is the obvious shortcut and it is genuinely dangerous.
 *
 * A price in the bundle is a price the visitor controls. They open devtools,
 * edit the number, and the checkout call carries their figure instead of yours.
 * Whether that actually charges the wrong amount depends entirely on whether the
 * server re-reads the price — and if a developer was relaxed enough to hardcode
 * it in the client, that check is usually missing too. The two mistakes travel
 * together.
 *
 * So: the frontend renders prices, it never states them. The backend's checkout
 * route reads from the `products` table and ignores anything the client sends
 * about amounts. This hook is the only supported way to get a price on screen.
 */

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  /** Minor units — cents, pence. Never a float; floats and money do not mix. */
  amount_cents: number;
  currency: string;
  recurring: string;
}

export interface CommerceState {
  products: Product[];
  loading: boolean;
  /** Set when the fetch failed. Sections render their empty state rather than nothing. */
  error: string | null;
}

export function useProducts(): CommerceState {
  const [state, setState] = useState<CommerceState>({ products: [], loading: true, error: null });

  useEffect(() => {
    let alive = true;

    // The server returns active products only, cheapest first.
    api.products()
      .then((data) => {
        if (!alive) return;
        setState({ products: data.products, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // Deliberately not surfacing the server's message to the visitor. A
        // failed price lookup should read as "unavailable", not as a stack trace.
        setState({ products: [], loading: false, error: 'Pricing is temporarily unavailable.' });
        if (import.meta.env.DEV) console.error('products fetch failed', err);
      });

    return () => { alive = false; };
  }, []);

  return state;
}

/**
 * Format for display, using the visitor's locale and the product's own currency.
 *
 * Two things this gets right that hand-rolled formatting does not: it puts the
 * symbol where the locale expects it (€ trails in French, leads in English), and
 * it handles zero-decimal currencies — yen has no minor unit, so dividing by 100
 * would show ¥1,600 as ¥16.
 */
export function formatPrice(cents: number, currency: string, locale?: string): string {
  const fmt = new Intl.NumberFormat(locale ?? navigator.language, {
    style: 'currency', currency,
  });
  const zeroDecimal = fmt.resolvedOptions().maximumFractionDigits === 0;
  return fmt.format(zeroDecimal ? cents : cents / 100);
}

/**
 * Start a checkout.
 *
 * Sends product ids and quantities only. No amounts, no currency, no totals —
 * the server derives all of it. If this function ever grows a `price` parameter,
 * that is the bug.
 */
export async function startCheckout(items: Array<{ sku: string; quantity: number }>): Promise<void> {
  const { checkout_url } = await api.checkout(items);
  window.location.assign(checkout_url);
}
