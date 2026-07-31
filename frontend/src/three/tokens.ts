/**
 * Reads the active design direction's 3D bias out of CSS custom properties.
 *
 * Keeping lighting and material intent in the same place as the palette is
 * what stops the 3D layer drifting away from the visual identity. When Fable
 * switches `data-direction`, the scene relights itself with no JS change.
 */
export interface ThreeTokens {
  env: string;
  envIntensity: number;
  keyIntensity: number;
  fillIntensity: number;
  metalness?: number;
  roughness?: number;
  iridescence?: number;
  transmission?: number;
  ior?: number;
  dispersion?: number;
  bgMode: 'solid' | 'gradient' | 'transparent' | 'hdri_visible';
  bg: string;
  surface: string;
  accent: string;
  ink: string;
}

const num = (styles: CSSStyleDeclaration, name: string, fallback?: number) => {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (styles: CSSStyleDeclaration, name: string, fallback: string) =>
  styles.getPropertyValue(name).trim().replace(/^['"]|['"]$/g, '') || fallback;

export function readThreeTokens(): ThreeTokens {
  if (typeof window === 'undefined') {
    return { env: 'studio', envIntensity: 1, keyIntensity: 1.5, fillIntensity: 0.5,
      bgMode: 'solid', bg: '#111111', surface: '#888888', accent: '#ffffff', ink: '#ffffff' };
  }
  const s = getComputedStyle(document.documentElement);
  return {
    env: str(s, '--three-env', 'studio'),
    envIntensity: num(s, '--three-env-intensity', 1)!,
    keyIntensity: num(s, '--three-key-intensity', 1.5)!,
    fillIntensity: num(s, '--three-fill-intensity', 0.5)!,
    metalness: num(s, '--three-metalness'),
    roughness: num(s, '--three-roughness'),
    iridescence: num(s, '--three-iridescence'),
    transmission: num(s, '--three-transmission'),
    ior: num(s, '--three-ior'),
    dispersion: num(s, '--three-dispersion'),
    bgMode: str(s, '--three-bg-mode', 'solid') as ThreeTokens['bgMode'],
    bg: str(s, '--bg', '#111111'),
    surface: str(s, '--surface', '#888888'),
    accent: str(s, '--accent', '#ffffff'),
    ink: str(s, '--ink', '#ffffff'),
  };
}
