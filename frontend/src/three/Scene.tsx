import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, AdaptiveDpr, AdaptiveEvents, PerformanceMonitor, Preload } from '@react-three/drei';
import * as THREE from 'three';
import { ModelSlot } from './ModelSlot';
import { readThreeTokens } from './tokens';
import { detectQuality, downgrade, type QualityProfile } from './quality';
import type { AssetEntry } from '../lib/manifest';

interface SceneProps {
  assets: AssetEntry[];
  /** Section scroll progress, 0–1, for scroll_scrub assets. */
  progress?: number;
  cameraPosition?: [number, number, number];
  fov?: number;
  className?: string;
}

/**
 * The Canvas host. Everything expensive is conditional on the measured
 * quality profile, and the whole component is only ever mounted by ThreeStage
 * after it has confirmed WebGL is both available and appropriate.
 */
export default function Scene({
  assets, progress = 0, cameraPosition = [0, 0, 3.2], fov = 42, className,
}: SceneProps) {
  const tokens = useMemo(readThreeTokens, []);
  const [quality, setQuality] = useState<QualityProfile>(() => detectQuality());
  const pointer = useRef({ x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);

  const needsPointer = assets.some((a) => a.animation?.mode === 'pointer_parallax');

  useEffect(() => {
    if (!needsPointer) return;
    // One listener for the whole scene rather than one per model, and passive
    // so it never blocks scrolling.
    const onMove = (e: PointerEvent) => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect) return;
      pointer.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.current.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [needsPointer]);

  const handleDecline = useCallback(() => {
    setQuality((q) => (q.tier === 'high' || q.tier === 'medium' ? downgrade(q, 'low-fps') : q));
  }, []);

  if (quality.tier === 'off') return null;

  return (
    <div ref={hostRef} className={className} data-quality={quality.tier}>
      <Canvas
        // 'demand' means the loop is idle unless something invalidates it.
        // For a page whose models mostly drift slowly, this cuts GPU time by
        // an order of magnitude versus a permanent 60fps loop.
        frameloop={quality.frameloop === 'never' ? 'never' : 'always'}
        dpr={[1, quality.maxDpr]}
        shadows={quality.shadows}
        camera={{ position: cameraPosition, fov, near: 0.1, far: 100 }}
        gl={{
          antialias: quality.antialias,
          alpha: tokens.bgMode === 'transparent',
          powerPreference: 'high-performance',
          // Needed only if the client ever wants a screenshot of the canvas;
          // costs a frame copy, so it stays off.
          preserveDrawingBuffer: false,
          stencil: false,
          depth: true,
        }}
        onCreated={({ gl, scene }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          if (tokens.bgMode === 'solid') scene.background = new THREE.Color(tokens.bg);
        }}
      >
        <ContextLossGuard />
        <PerformanceMonitor onDecline={handleDecline} flipflops={3} />
        <AdaptiveDpr pixelated={false} />
        <AdaptiveEvents />

        <Lighting quality={quality} />

        <Suspense fallback={null}>
          {assets.map((asset) => (
            <ModelSlot
              key={asset.key}
              asset={asset}
              pointer={pointer.current}
              progress={progress}
            />
          ))}
          {tokens.env !== 'none' && (
            <Environment
              preset={tokens.env as never}
              environmentIntensity={tokens.envIntensity}
              background={tokens.bgMode === 'hdri_visible'}
              blur={tokens.bgMode === 'hdri_visible' ? 0.4 : 0}
              resolution={quality.envResolution}
            />
          )}
          <Preload all />
        </Suspense>
      </Canvas>
    </div>
  );
}

function Lighting({ quality }: { quality: QualityProfile }) {
  const tokens = useMemo(readThreeTokens, []);
  return (
    <>
      <ambientLight intensity={tokens.fillIntensity} />
      <directionalLight
        position={[3, 4, 2]}
        intensity={tokens.keyIntensity}
        castShadow={quality.shadows}
        shadow-mapSize={quality.tier === 'high' ? [2048, 2048] : [1024, 1024]}
        shadow-bias={-0.0005}
      >
        {/* Tight shadow frustum. The default is enormous and wastes almost all
            of the shadow map on empty space, which is why default r3f shadows
            look soft and blocky. */}
        <orthographicCamera attach="shadow-camera" args={[-2.5, 2.5, 2.5, -2.5, 0.1, 12]} />
      </directionalLight>
      <directionalLight position={[-3, 1, -2]} intensity={tokens.fillIntensity * 0.6} />
    </>
  );
}

/**
 * WebGL contexts get dropped: a laptop sleeping, a GPU driver reset, too many
 * live canvases. Untreated, the site is left with a permanently blank black
 * rectangle. Recovering is a handful of lines and almost nobody writes them.
 */
function ContextLossGuard() {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (e: Event) => {
      e.preventDefault();              // required, or the context never restores
      canvas.dataset.contextLost = 'true';
    };
    const onRestored = () => {
      delete canvas.dataset.contextLost;
      invalidate();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }, [gl, invalidate]);
  return null;
}
