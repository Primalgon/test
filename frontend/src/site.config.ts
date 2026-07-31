/**
 * Brief-derived site configuration.
 *
 * Fable rewrites this file from brief.json at generate time. It is the only
 * place a generated site holds business-specific values — components read from
 * here so that regenerating a site for a different client is a config swap
 * rather than a find-and-replace across the component tree.
 *
 * Every string below is real copy from the brief. Lorem ipsum, "Your Company
 * Here", and placeholder taglines fail step-5 QA.
 */
export interface SiteConfig {
  name: string;
  domain: string;
  direction: string;
  locale: string;
  tagline: string;
  description: string;
  audience: string;
  contact: { email: string; phone?: string; address?: string; socials?: Record<string, string> };
  cta: { label: string; action: 'checkout' | 'booking' | 'contact_form' | 'external_link' | 'signup'; target?: string };
  nav: Array<{ label: string; href: string }>;
  motionIntensity: 'still' | 'restrained' | 'alive' | 'cinematic';
  /** Optional brand colours from brief.design.palette_locks, applied over the direction pack. */
  paletteLocks?: string[];
}

export const site: SiteConfig = {
  name: 'Reelroom',
  domain: 'reelroom.test',
  direction: 'liquid-chrome',
  locale: 'en-US',
  tagline: 'Films and series that follow you to every screen you own',
  description: 'Every plan is ad-free. Start on the TV, finish on your phone — playback picks up where you left off.',
  audience: 'people who want their films and series in one place, without ads',
  contact: {
    email: 'hello@reelroom.test',
  },
  cta: { label: 'Start watching', action: 'signup', target: '/signup' },
  nav: [
    { label: 'Plans', href: '/#plans' },
    { label: 'Questions', href: '/#faq' },
    { label: 'Contact', href: '/contact' },
  ],
  motionIntensity: 'alive',
};

/**
 * Applies the direction and any client palette locks to <html> before first
 * paint. Called from main.tsx ahead of React mounting so there is no flash of
 * the wrong identity.
 */
export function applyDirection(config: SiteConfig = site) {
  const root = document.documentElement;
  root.dataset.direction = config.direction;
  root.lang = config.locale;
  config.paletteLocks?.forEach((hex, i) => root.style.setProperty(`--brand-${i + 1}`, hex));

  // Keep the mobile browser chrome in step with the palette.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
