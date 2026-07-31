import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Center } from '@react-three/drei';
import * as THREE from 'three';
import type { AssetEntry } from '../lib/manifest';
import { readThreeTokens } from './tokens';

/**
 * ModelSlot is the single point where the pipeline's step-4 swap lands.
 *
 * Steps 3 and 4 differ by one JSON field. Fable writes the manifest with
 * status:"placeholder" and a primitive shape; Higgsfield's output flips it to
 * status:"ready" with a url. No component, route, or import changes — which is
 * what makes the swap safe to automate, because an automated code edit at that
 * stage is where this kind of pipeline usually breaks.
 */

interface Props {
  asset: AssetEntry;
  /** Pointer position in NDC, shared by the Scene so N models cost one listener. */
  pointer?: { x: number; y: number };
  /** 0–1 scroll progress through the host section, for scroll_scrub animation. */
  progress?: number;
  onLoaded?: (info: { key: string; triangles: number }) => void;
}

export function ModelSlot({ asset, pointer, progress = 0, onLoaded }: Props) {
  const ready = asset.status === 'ready' && !!asset.url;
  return (
    <Suspense fallback={<PrimitiveStandIn asset={asset} />}>
      {ready
        ? <LoadedModel asset={asset} pointer={pointer} progress={progress} onLoaded={onLoaded} />
        : <PrimitiveStandIn asset={asset} pointer={pointer} />}
    </Suspense>
  );
}

/* -------------------------------------------------------------------------- */

function LoadedModel({ asset, pointer, progress, onLoaded }: Props) {
  const group = useRef<THREE.Group>(null);
  const { scene } = useGLTF(asset.url!);
  const tokens = useMemo(readThreeTokens, []);
  const invalidate = useThree((s) => s.invalidate);

  /**
   * Clone before touching anything. useGLTF caches by URL, so mutating the
   * returned scene mutates every other instance of the same model on the page —
   * a bug that only shows up once a site reuses one asset in two places, which
   * is exactly what our showcase sections do.
   */
  const model = useMemo(() => {
    const clone = scene.clone(true);
    let triangles = 0;

    clone.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = true;

      const geom = child.geometry as THREE.BufferGeometry;
      triangles += geom.index ? geom.index.count / 3 : geom.attributes.position!.count / 3;

      /**
       * Re-bias the material toward the active design direction. Higgsfield
       * returns a neutral PBR setup; left alone, a chrome-direction site gets a
       * matte grey blob and a botanical site gets a mirror. This is the step
       * that makes generated 3D look art-directed rather than dropped in.
       */
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      child.material = mats.map((m) => {
        if (!(m instanceof THREE.MeshStandardMaterial)) return m;
        const next = m.clone();
        next.metalness = tokens.metalness ?? next.metalness;
        next.roughness = tokens.roughness ?? next.roughness;
        next.envMapIntensity = tokens.envIntensity ?? 1;
        if (tokens.iridescence && 'iridescence' in next) {
          (next as unknown as THREE.MeshPhysicalMaterial).iridescence = tokens.iridescence;
          (next as unknown as THREE.MeshPhysicalMaterial).iridescenceIOR = 1.8;
        }
        if (tokens.transmission && 'transmission' in next) {
          const phys = next as unknown as THREE.MeshPhysicalMaterial;
          phys.transmission = tokens.transmission;
          phys.ior = tokens.ior ?? 1.5;
          phys.thickness = 1;
          if ('dispersion' in phys && tokens.dispersion) phys.dispersion = tokens.dispersion;
          phys.transparent = true;
        }
        next.needsUpdate = true;
        return next;
      }) as THREE.Material | THREE.Material[];
      if (Array.isArray(child.material) && child.material.length === 1) child.material = child.material[0]!;
    });

    onLoaded?.({ key: asset.key, triangles: Math.round(triangles) });
    return clone;
  }, [scene, tokens, asset.key, onLoaded]);

  /**
   * Normalise scale. Generated meshes arrive at wildly inconsistent sizes —
   * one comes back 0.02 units tall, the next 340. Fitting to a unit box before
   * applying the brief's scale hint is the only way a layout stays predictable
   * across regenerations.
   */
  useLayoutEffect(() => {
    if (!group.current || asset.transform?.autofit === false) return;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (longest > 0 && Number.isFinite(longest)) {
      const norm = 1 / longest;
      group.current.scale.setScalar(norm * (asset.transform?.scale ?? 1));
    }
    invalidate();
  }, [model, asset.transform, invalidate]);

  useEffect(() => () => {
    // Free GPU memory when the section unmounts. Without this, a multi-page
    // site leaks a full geometry + texture set per navigation until the tab
    // runs out of VRAM.
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          for (const value of Object.values(m)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          m.dispose();
        }
      }
    });
  }, [model]);

  useAnimation(group, asset, pointer, progress);

  const t = asset.transform;
  return (
    <group
      ref={group}
      position={t?.position ?? [0, 0, 0]}
      rotation={t?.rotation ?? [0, 0, 0]}
    >
      <Center disableY={asset.placement === 'hero'}>
        <primitive object={model} />
      </Center>
    </group>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The pre-upgrade shape. Occupies the same volume as the final model so the
 * page composes correctly during steps 3–4 and the swap produces zero visual
 * jump. It is intentionally a real, lit object rather than a spinner: the
 * client reviewing an early preview should see a plausible page.
 */
function PrimitiveStandIn({ asset, pointer }: { asset: AssetEntry; pointer?: { x: number; y: number } }) {
  const group = useRef<THREE.Group>(null);
  const tokens = useMemo(readThreeTokens, []);
  const shape = asset.primitive?.shape ?? 'icosahedron';

  useAnimation(group, asset, pointer, 0);

  return (
    <group ref={group} scale={asset.transform?.scale ?? 1} position={asset.transform?.position ?? [0, 0, 0]}>
      <mesh castShadow receiveShadow>
        {shape === 'box' && <boxGeometry args={(asset.primitive?.args as [number, number, number]) ?? [1, 1, 1]} />}
        {shape === 'sphere' && <sphereGeometry args={[0.6, 48, 48]} />}
        {shape === 'torus' && <torusGeometry args={[0.5, 0.2, 32, 96]} />}
        {shape === 'cylinder' && <cylinderGeometry args={[0.45, 0.45, 1.1, 48]} />}
        {shape === 'capsule' && <capsuleGeometry args={[0.35, 0.7, 16, 32]} />}
        {shape === 'icosahedron' && <icosahedronGeometry args={[0.7, 1]} />}
        <meshStandardMaterial
          color={tokens.surface}
          metalness={tokens.metalness ?? 0.2}
          roughness={tokens.roughness ?? 0.6}
          envMapIntensity={tokens.envIntensity ?? 1}
          flatShading={shape === 'icosahedron'}
        />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------------------- */

function useAnimation(
  ref: React.RefObject<THREE.Group | null>,
  asset: AssetEntry,
  pointer?: { x: number; y: number },
  progress = 0,
) {
  const mode = asset.animation?.mode ?? 'float';
  const speed = asset.animation?.speed ?? 1;
  const target = useRef({ x: 0, y: 0 });

  useFrame((state, delta) => {
    const g = ref.current;
    if (!g || mode === 'none') return;
    // Clamp delta: a backgrounded tab returns a huge first delta and the model
    // visibly snaps. Capping at ~3 frames keeps the return smooth.
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;

    switch (mode) {
      case 'spin':
        g.rotation.y += dt * 0.4 * speed;
        break;
      case 'float':
        g.rotation.y += dt * 0.15 * speed;
        g.position.y = (asset.transform?.position?.[1] ?? 0) + Math.sin(t * 0.7 * speed) * 0.06;
        break;
      case 'pointer_parallax':
        target.current.y = (pointer?.x ?? 0) * 0.5;
        target.current.x = (pointer?.y ?? 0) * -0.3;
        g.rotation.y += (target.current.y - g.rotation.y) * Math.min(1, dt * 4);
        g.rotation.x += (target.current.x - g.rotation.x) * Math.min(1, dt * 4);
        break;
      case 'scroll_scrub':
        g.rotation.y = progress * Math.PI * 2 * speed;
        g.position.y = (asset.transform?.position?.[1] ?? 0) - progress * 0.4;
        break;
    }
  });
}

/** Warm the cache for above-the-fold models during idle time. */
export function preloadAssets(assets: AssetEntry[]) {
  const heroes = assets.filter((a) => a.status === 'ready' && a.url && a.placement === 'hero');
  for (const a of heroes) useGLTF.preload(a.url!);
}
