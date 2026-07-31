import raw from '../data/assets.manifest.json';

/**
 * The asset manifest is the contract between Fable (step 3), Higgsfield
 * (step 4) and the running site. It is a plain JSON file so an automation can
 * rewrite it safely; no component imports a model URL directly.
 *
 * At runtime the site also fetches /api/assets and merges any newer state on
 * top. That way an asset regenerated from the admin dashboard appears without
 * a rebuild — which matters because a rebuild means a deploy, and a deploy for
 * a swapped mesh is a bad trade.
 */
export interface AssetEntry {
  key: string;
  status: 'placeholder' | 'generating' | 'ready' | 'failed';
  source: 'primitive' | 'higgsfield' | 'client_supplied';
  url: string | null;
  poster: string | null;
  placement: 'hero' | 'showcase' | 'inline' | 'background' | 'cursor_follow' | 'scroll_scrub';
  alt: string;
  primitive?: { shape: 'box' | 'sphere' | 'torus' | 'cylinder' | 'icosahedron' | 'capsule'; args?: number[] };
  transform?: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: number; autofit?: boolean };
  material_hint?: string;
  animation?: { mode?: 'none' | 'spin' | 'float' | 'scroll_scrub' | 'pointer_parallax' | 'clip'; clip_name?: string | null; speed?: number };
  budget?: { bytes?: number; triangles?: number };
}

export interface Manifest {
  manifest_version: number;
  brief_id: string;
  generated_at: string;
  upgraded_at: string | null;
  assets: AssetEntry[];
}

const local = raw as unknown as Manifest;

export const manifest = local;

/** Look up by the stable key from the brief. Never by filename. */
export const getAsset = (key: string): AssetEntry | undefined =>
  local.assets.find((a) => a.key === key);

export const getAssets = (...keys: string[]): AssetEntry[] =>
  keys.map(getAsset).filter((a): a is AssetEntry => !!a);

export const getByPlacement = (placement: AssetEntry['placement']): AssetEntry[] =>
  local.assets.filter((a) => a.placement === placement);

/** True while any asset is still on a placeholder — QA blocks release on this. */
export const isFullyUpgraded = () =>
  local.assets.every((a) => a.status === 'ready' || a.source === 'client_supplied');

/**
 * Merge live asset state from the API over the bundled manifest. Called once
 * at boot; failure is non-fatal because the bundled manifest is always valid
 * on its own.
 */
export async function hydrateFromApi(signal?: AbortSignal): Promise<Manifest> {
  try {
    const res = await fetch('/api/assets', { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return local;
    const { assets } = (await res.json()) as {
      assets: Array<{ asset_key: string; status: string; source: string; url: string | null; poster_url: string | null }>;
    };
    for (const remote of assets) {
      const entry = local.assets.find((a) => a.key === remote.asset_key);
      if (!entry) continue;
      // Only ever upgrade. A stale API row must not knock a working model back
      // to a placeholder.
      if (remote.status === 'ready' && remote.url) {
        entry.status = 'ready';
        entry.url = remote.url;
        entry.source = remote.source as AssetEntry['source'];
        if (remote.poster_url) entry.poster = remote.poster_url;
      }
    }
    return local;
  } catch {
    return local;
  }
}
