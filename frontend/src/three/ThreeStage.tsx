import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { detectQuality } from './quality';
import type { AssetEntry } from '../lib/manifest';

/**
 * The gate in front of all 3D.
 *
 * Scene (and therefore three.js, ~600kB) is behind a dynamic import that only
 * resolves when three conditions hold:
 *   1. the device can and should run WebGL   (quality.ts, no three import)
 *   2. the section is near the viewport      (IntersectionObserver)
 *   3. the browser is idle                   (requestIdleCallback)
 *
 * Anyone who fails (1) — reduced motion, save-data, no WebGL, software
 * rasteriser — gets the poster image and never downloads the 3D bundle at all.
 * That is the whole reason a heavy 3D site can still pass Core Web Vitals.
 */
const Scene = lazy(() => import('./Scene'));

interface Props {
  assets: AssetEntry[];
  /** Shown when 3D is unavailable, still loading, or has failed. */
  posterSrc?: string | null;
  alt: string;
  aspect?: string;
  cameraPosition?: [number, number, number];
  fov?: number;
  /** Track scroll progress through this element and pass it to scroll_scrub assets. */
  trackProgress?: boolean;
  className?: string;
}

export function ThreeStage({
  assets, posterSrc, alt, aspect = '16 / 10',
  cameraPosition, fov, trackProgress = false, className = '',
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const quality = detectQuality();

  const usable = quality.tier !== 'off' && assets.length > 0;

  useEffect(() => {
    if (!usable || !host.current) return;
    const el = host.current;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        const start = () => setShouldRender(true);
        // Yield to anything more important first; fall back on Safari.
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(start, { timeout: 1200 });
        } else {
          setTimeout(start, 200);
        }
      },
      // Start work a viewport early so the model is there by the time it is seen.
      { rootMargin: '250px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [usable]);

  useEffect(() => {
    if (!trackProgress || !shouldRender || !host.current) return;
    const el = host.current;
    let raf = 0;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const total = rect.height + window.innerHeight;
      const seen = window.innerHeight - rect.top;
      setProgress(Math.max(0, Math.min(1, seen / total)));
      raf = 0;
    };
    // rAF-throttled: a raw scroll handler that calls setState fires hundreds of
    // times a second and turns a smooth page into a janky one.
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [trackProgress, shouldRender]);

  const showPoster = !usable || failed || !shouldRender;

  return (
    <div
      ref={host}
      className={`canvas-host ${className}`}
      style={{ ['--canvas-aspect' as string]: aspect }}
      role="img"
      aria-label={alt}
      data-three-state={!usable ? 'unavailable' : failed ? 'failed' : shouldRender ? 'live' : 'pending'}
    >
      {showPoster && posterSrc && (
        <img
          className="canvas-poster"
          src={posterSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          data-heavy-media
        />
      )}
      {showPoster && !posterSrc && usable && <div className="asset-loading" aria-hidden="true" />}

      {usable && shouldRender && !failed && (
        <ErrorBoundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene
              assets={assets}
              progress={progress}
              cameraPosition={cameraPosition}
              fov={fov}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

import { Component, type ReactNode } from 'react';

/**
 * A shader compile failure or a corrupt GLB throws during render and would
 * otherwise blank the entire page. Catching it here degrades one section to
 * its poster image and leaves the rest of the site working.
 */
class ErrorBoundary extends Component<
  { children: ReactNode; onError: (e: Error) => void },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) {
    this.props.onError(error);
    if (import.meta.env.DEV) console.error('[ThreeStage] 3D render failed:', error);
  }
  render() { return this.state.hasError ? null : this.props.children; }
}
