/**
 * Content protection for a generated client site.
 *
 * ## Read this before enabling any of it
 *
 * None of this is security. It cannot be. Everything a browser displays has
 * already been downloaded to the visitor's machine — the image is in the cache,
 * the text is in the DOM, and the page source is one keystroke away in a menu
 * that cannot be removed. There is no version of this file that changes that,
 * and any library claiming otherwise is selling you a placebo.
 *
 * What "blocking F12" actually does when people try it:
 *
 *   - `keydown` on F12 — the menu still opens devtools. Two clicks.
 *   - Blocking right-click — View Source is still in the browser menu, and
 *     Ctrl+U still works.
 *   - The `debugger` statement loop — devtools has a "never pause here" option.
 *     Meanwhile every honest visitor whose browser hiccups gets a frozen tab.
 *   - Detecting devtools by window size — fires on every split-screen user and
 *     misses anyone who undocks the panel.
 *   - Disabling text selection site-wide — breaks accessibility tooling, breaks
 *     "look up this word", breaks copying an address or a phone number, and
 *     tanks the experience for the 99% of visitors who were never a threat.
 *
 * So the value here is **deterrence against casual copying**, and it is real but
 * narrow: a photographer's portfolio where right-click-save is the actual
 * observed behaviour, a pricing sheet a competitor screenshots. It raises the
 * effort from zero to slightly-above-zero. That is worth something to some
 * clients, and worth nothing against anyone determined.
 *
 * **The control that matters is on the other side of the wire:** nothing
 * sensitive is in the bundle in the first place. Prices resolve server-side.
 * There are no keys in the frontend. The API index returns nothing in
 * production. Source maps are off. Full-resolution originals are never the file
 * the page loads. That is what protects a client site — see SECURITY.md.
 *
 * Enable per-brief via `design.content_protection`, and be honest with the
 * client about what they are buying.
 */

export interface ProtectionOptions {
  /** Right-click and drag on images only. The lowest-cost, highest-value option. */
  images?: boolean;
  /** Suppress copy on marked elements. Use `data-protect` to scope it. */
  text?: boolean;
  /** Append an attribution line to copied text instead of blocking it. */
  copyAttribution?: { siteName: string; url: string } | false;
  /** Print stylesheet that hides marked content. */
  print?: boolean;
}

let installed = false;

/**
 * Install protections. Idempotent, and a no-op if nothing is enabled.
 *
 * Everything here is scoped by attribute rather than applied globally. A
 * site-wide selection block is the version that generates support tickets;
 * `data-protect` on the gallery is the version a client actually wants.
 */
export function installProtection(opts: ProtectionOptions): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;

  const teardown: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    type: K, fn: (e: DocumentEventMap[K]) => void, options?: AddEventListenerOptions,
  ) => {
    document.addEventListener(type, fn as EventListener, options);
    teardown.push(() => document.removeEventListener(type, fn as EventListener));
  };

  /* ---------------- Images ---------------- */

  if (opts.images) {
    // Right-click on images only. Blocking it page-wide removes the browser's
    // own useful features (translate, search, back) from every visitor to stop
    // a save action that the network tab makes trivial anyway.
    on('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG' || target.closest('[data-protect="image"]')) {
        e.preventDefault();
      }
    });

    // Drag-to-desktop is the other one-gesture path. Cheap to close.
    on('dragstart', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG' || target.closest('[data-protect="image"]')) {
        e.preventDefault();
      }
    });
  }

  /* ---------------- Text ---------------- */

  if (opts.text) {
    on('copy', (e) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      const node = selection.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      if (!el?.closest('[data-protect="text"]')) return;
      e.preventDefault();
    });
  }

  /* ---------------- Copy attribution ---------------- */

  if (opts.copyAttribution) {
    const { siteName, url } = opts.copyAttribution;
    /**
     * Strictly better than blocking copy, for most clients.
     *
     * Someone copying a paragraph is usually quoting it, sharing it, or pasting
     * it into an email to a colleague — all of which are good for the client.
     * Blocking that costs a referral. Appending a source line keeps the referral
     * and adds attribution, which is what the client actually wanted.
     */
    on('copy', (e) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      const text = selection.toString();
      // Short selections are addresses, phone numbers, prices — leave them alone.
      if (text.length < 120) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', `${text}\n\n— ${siteName}, ${url}`);
    });
  }

  /* ---------------- Print ---------------- */

  if (opts.print) {
    const style = document.createElement('style');
    style.setAttribute('data-protection', 'print');
    style.textContent = `@media print {
      [data-protect="print"], [data-protect="image"] { display: none !important; }
      [data-protect="print"]::after {
        content: "Content omitted from print — view at the original site.";
        display: block; font-style: italic;
      }
    }`;
    document.head.appendChild(style);
    teardown.push(() => style.remove());
  }

  return () => {
    for (const fn of teardown) fn();
    installed = false;
  };
}

/**
 * Image URL builder for protected media.
 *
 * This does far more than any event handler above, and it is the part worth
 * spending effort on. A right-click block is defeated by the network tab in
 * about four seconds; serving a 1200px display copy instead of the 6000px
 * original means the file an attacker takes is genuinely not the asset the
 * client is protecting.
 *
 * Pair it with Cloudflare Images or R2 + a resizing worker. The originals stay
 * in a private bucket the site never links to.
 */
export function protectedImageUrl(
  key: string,
  opts: { width?: number; quality?: number; watermark?: boolean } = {},
): string {
  const params = new URLSearchParams();
  // Cap at a generous display size. Anything larger is for the client's own
  // print use and does not belong on a public page.
  params.set('w', String(Math.min(opts.width ?? 1200, 2000)));
  params.set('q', String(opts.quality ?? 82));
  params.set('fmt', 'auto');
  if (opts.watermark) params.set('wm', '1');
  return `/api/media/${encodeURIComponent(key)}?${params.toString()}`;
}

/**
 * What to tell the client, in plain language.
 *
 * Included as an export so the generated admin dashboard can show it verbatim.
 * A client who believes their images are uncopyable will be upset later; a
 * client who was told the truth up front will not.
 */
export const PROTECTION_DISCLOSURE = `
Content protection reduces casual copying. It stops right-click saving, dragging
images to the desktop, and copying large blocks of text without attribution.

It cannot prevent screenshots, and it cannot stop someone who knows how to use
browser developer tools. No website can — anything your browser can display has
already been sent to the visitor's computer.

What genuinely protects your work: images are served at display resolution
rather than full quality, originals are never published, and everything
commercially sensitive (prices, stock, customer data) lives on the server where
visitors cannot reach it.
`.trim();
