/**
 * Capability detection and quality tiering.
 *
 * This module deliberately contains no three.js import. It runs before the
 * ~600kB three chunk is fetched, so a device that cannot or should not render
 * WebGL never downloads it. That single decision is the difference between a
 * 3D site that scores well on a mid-range Android and one that does not.
 */

export type Tier = 'off' | 'low' | 'medium' | 'high';

export interface QualityProfile {
  tier: Tier;
  /** Upper bound on devicePixelRatio. Retina at DPR 3 is 9x the fragment work. */
  maxDpr: number;
  antialias: boolean;
  shadows: boolean;
  /** Environment map resolution. */
  envResolution: 64 | 128 | 256;
  /** Render only when something changed, vs. a continuous 60fps loop. */
  frameloop: 'always' | 'demand' | 'never';
  /** Why we landed on this tier — surfaced in the admin dashboard and QA logs. */
  reason: string;
}

const OFF: QualityProfile = {
  tier: 'off', maxDpr: 1, antialias: false, shadows: false,
  envResolution: 64, frameloop: 'never', reason: 'unset',
};

let cached: QualityProfile | null = null;

export function detectQuality(): QualityProfile {
  if (cached) return cached;
  cached = compute();
  return cached;
}

function compute(): QualityProfile {
  if (typeof window === 'undefined') return { ...OFF, reason: 'server' };

  // 1. Explicit user signals win over anything we can measure.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return { ...OFF, reason: 'prefers-reduced-motion' };
  }
  if (window.matchMedia?.('(prefers-reduced-data: reduce)').matches) {
    return { ...OFF, reason: 'prefers-reduced-data' };
  }

  // 2. Save-Data header equivalent, plus very slow connections.
  const conn = (navigator as any).connection;
  if (conn?.saveData) return { ...OFF, reason: 'save-data' };
  if (conn?.effectiveType && ['slow-2g', '2g'].includes(conn.effectiveType)) {
    return { ...OFF, reason: `connection:${conn.effectiveType}` };
  }

  // 3. Can this browser do WebGL2 at all? Probe on a throwaway canvas and
  //    release the context immediately — a leaked probe context counts against
  //    the browser's hard limit of ~16 and will break the real canvas later.
  const probe = document.createElement('canvas');
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
  } catch { /* fall through */ }

  if (!gl) {
    try {
      gl = probe.getContext('webgl', { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
    } catch { /* fall through */ }
    if (!gl) return { ...OFF, reason: 'no-webgl' };
  }

  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  // 4. Renderer string is the single best signal available in the browser.
  let renderer = '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  // Release the probe context explicitly.
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as any).deviceMemory as number | undefined;
  const dpr = window.devicePixelRatio || 1;
  const lowered = renderer.toLowerCase();

  // Software rasterisers: technically WebGL, practically a slideshow.
  if (/swiftshader|llvmpipe|software|basic render/.test(lowered)) {
    return { ...OFF, reason: `software-renderer:${renderer.slice(0, 40)}` };
  }

  if (maxTexture < 4096 || cores <= 2 || (memory !== undefined && memory <= 2)) {
    return {
      tier: 'low', maxDpr: 1, antialias: false, shadows: false,
      envResolution: 64, frameloop: 'demand',
      reason: `constrained(cores:${cores},mem:${memory ?? '?'},tex:${maxTexture})`,
    };
  }

  const highEnd = /apple m[1-9]|rtx|radeon rx|arc a|adreno 7\d\d|mali-g7\d/.test(lowered);
  if (isWebGL2 && highEnd && cores >= 8) {
    return {
      tier: 'high', maxDpr: Math.min(dpr, 2), antialias: true, shadows: true,
      envResolution: 256, frameloop: 'demand',
      reason: `high(${renderer.slice(0, 40) || 'unknown'})`,
    };
  }

  return {
    tier: 'medium', maxDpr: Math.min(dpr, 1.75), antialias: true, shadows: false,
    envResolution: 128, frameloop: 'demand',
    reason: `medium(cores:${cores},webgl2:${isWebGL2})`,
  };
}

/** Escape hatch for QA and for the "reduce motion" control in the site footer. */
export function forceQuality(tier: Tier) {
  cached = tier === 'off'
    ? { ...OFF, reason: 'forced' }
    : { ...detectQuality(), tier, reason: 'forced' };
  document.documentElement.dataset.quality = tier;
  window.dispatchEvent(new CustomEvent('quality:changed', { detail: cached }));
  return cached;
}

/**
 * Runtime downgrade. The Scene calls this when measured frame time stays bad —
 * a device can pass every static check and still thermally throttle two
 * minutes in, which static detection alone will never catch.
 */
export function downgrade(current: QualityProfile, reason: string): QualityProfile {
  const next: Record<Tier, Tier> = { high: 'medium', medium: 'low', low: 'off', off: 'off' };
  const tier = next[current.tier];
  const profile: QualityProfile =
    tier === 'off'
      ? { ...OFF, reason: `downgraded:${reason}` }
      : {
          tier,
          maxDpr: tier === 'low' ? 1 : 1.5,
          antialias: tier !== 'low',
          shadows: false,
          envResolution: tier === 'low' ? 64 : 128,
          frameloop: 'demand',
          reason: `downgraded:${reason}`,
        };
  cached = profile;
  document.documentElement.dataset.quality = tier;
  return profile;
}
