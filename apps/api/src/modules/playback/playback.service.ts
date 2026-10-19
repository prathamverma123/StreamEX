import { NotFoundError, ForbiddenError } from '../../lib/errors.js';
import { getPrisma } from '../../lib/prisma.js';
import { loadEnv } from '../../config/env.js';
import { signHlsToken, verifyHlsToken } from '../../lib/signing.js';
import { StorageNotFoundError } from '@streamex/storage';
import { getStorage } from '../../lib/storage.js';
import type { ManifestQuery } from './playback.schemas.js';

/**
 * Playback service.
 *
 * 1. Resolve the asset (must be READY) and verify the profile may play it.
 * 2. Mint an HMAC-signed, expiring HLS token bound to {asset, profile, exp}.
 * 3. Build the playback URL: `${CDN_BASE_URL}/${prefix}/:token/master.m3u8`
 *    — nginx serves the segments and verifies nothing; the token itself
 *    authorizes the manifest AND every segment beneath it.
 * 4. Rendition selection: given the client's bandwidth hint and device width,
 *    pick the best rung whose bitrate fits with 20% headroom.
 */

export interface PlaybackManifest {
  assetId: string;
  playbackUrl: string;
  token: string;
  expiresAt: string;
  renditions: RenditionDto[];
  startRendition: string | null;
  thumbnailSpriteUrl: string | null;
  thumbnailVttUrl: string | null;
  subtitles: SubtitleDto[];
}

export interface RenditionDto {
  id: string;
  label: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  playlistUrl: string;
}

export interface SubtitleDto {
  id: string;
  language: string;
  label: string;
  url: string;
}

export async function createManifest(
  assetId: string,
  profileCtx: { id: string; isKids: boolean; maturity: number },
  query: ManifestQuery,
): Promise<PlaybackManifest> {
  const prisma = getPrisma();
  const env = loadEnv();
  const asset = await prisma.videoAsset.findFirst({
    where: { id: assetId, status: 'READY' },
    include: {
      renditions: { orderBy: { height: 'asc' } },
      subtitles: true,
      episode: { include: { season: { include: { title: true } } } },
      title: true,
    },
  });
  if (!asset) throw new NotFoundError('Video asset not found or not ready');

  // Ownership / maturity check
  const title = asset.title ?? asset.episode?.season.title;
  if (!title) throw new NotFoundError('Video asset has no title');
  const playable = isAllowed(title.rating, profileCtx);
  if (!playable) {
    throw new ForbiddenError('Title is not available for this profile');
  }

  const token = signHlsToken(
    {
      aid: asset.id,
      pid: profileCtx.id,
      exp: Math.floor(Date.now() / 1000) + env.HLS_TOKEN_TTL_SECONDS,
    },
    env.HLS_SIGNING_SECRET,
  );

  const base = `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${env.HLS_SEGMENT_PREFIX}`;
  const renditions: RenditionDto[] = asset.renditions.map((r) => ({
    id: r.id,
    label: r.label,
    width: r.width,
    height: r.height,
    videoBitrateKbps: r.videoBitrateKbps,
    audioBitrateKbps: r.audioBitrateKbps,
    playlistUrl: `${base}/${token}/renditions/${r.label}/index.m3u8`,
  }));

  return {
    assetId: asset.id,
    playbackUrl: `${base}/${token}/master.m3u8`,
    token,
    expiresAt: new Date(Date.now() + env.HLS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    renditions,
    startRendition: selectRendition(renditions, query),
    thumbnailSpriteUrl: asset.thumbnailSpriteKey
      ? `${base}/${token}/sprites/sprite.jpg`
      : null,
    thumbnailVttUrl: asset.thumbnailVttKey ? `${base}/${token}/sprites/thumbs.vtt` : null,
    subtitles: asset.subtitles.map((s) => ({
      id: s.id,
      language: s.language,
      label: s.label,
      url: `${base}/${token}/subtitles/${s.id}.vtt`,
    })),
  };
}

/** Pick the best rendition for the client's bandwidth / device. */
export function selectRendition(
  renditions: RenditionDto[],
  query: { bandwidth?: number; deviceWidth?: number },
): string | null {
  if (renditions.length === 0) return null;
  const byHeight = [...renditions].sort((a, b) => a.height - b.height);
  // No hints → highest quality is fine, player ABR will down-switch.
  if (!query.bandwidth && !query.deviceWidth) return byHeight[byHeight.length - 1]!.label;
  const maxPixels = query.deviceWidth ? Math.min(query.deviceWidth, 1920) : 1920;
  const budget = query.bandwidth ? query.bandwidth * 0.8 : Infinity;
  let best: RenditionDto | null = null;
  for (const r of byHeight) {
    const totalKbps = r.videoBitrateKbps + r.audioBitrateKbps;
    if (totalKbps * 1000 <= budget && r.width <= maxPixels) {
      best = r;
    }
  }
  if (best) return best.label;
  // Below the lowest rung → start on the smallest so the player can climb.
  return byHeight[0]!.label;
}

function isAllowed(rating: string, profile: { isKids: boolean; maturity: number }): boolean {
  const weights: Record<string, number> = {
    G: 0, 'TV-Y': 0, 'TV-G': 0,
    PG: 10, 'TV-Y7': 10, 'TV-PG': 30,
    'PG-13': 40, 'TV-14': 60,
    R: 80, 'TV-MA': 90, 'NC-17': 100,
  };
  const weight = weights[rating] ?? 100;
  if (profile.isKids) return weight <= 10;
  return weight <= profile.maturity;
}

/** Build the storage key for an asset's HLS output. */
export function assetHlsPrefix(assetId: string): string {
  return `assets/${assetId}/hls`;
}

/** Verify a playback token → asset/profile binding. Throws on invalid/expired. */
export function resolveToken(token: string): { assetId: string; profileId: string } | null {
  try {
    const payload = verifyHlsToken(token, loadEnv().HLS_SIGNING_SECRET);
    return { assetId: payload.aid, profileId: payload.pid };
  } catch {
    return null;
  }
}

/** Map a playback path (`master.m3u8`, `renditions/720p/index.m3u8`, ...) to a storage key. */
export function storageKeyFor(assetId: string, path: string): string {
  const clean = path.replace(/\.\./g, '').replace(/^\/+/, '');
  return `${assetHlsPrefix(assetId)}/${clean}`;
}

/** Content types for HLS artifacts. */
export function contentTypeFor(key: string): string {
  if (key.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.endsWith('.ts')) return 'video/mp2t';
  if (key.endsWith('.m4s')) return 'video/iso.segment';
  if (key.endsWith('.vtt')) return 'text/vtt';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/** Stream an HLS artifact from the storage backend. */
export async function streamObject(
  key: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; length?: number } | null> {
  const storage = await getStorage();
  try {
    const result = await storage.get(key);
    return { stream: result.stream, contentType: contentTypeFor(key), length: result.length };
  } catch (err) {
    if (err instanceof StorageNotFoundError) return null;
    throw err;
  }
}

/** Rendition list for the renditions endpoint. */
export async function listRenditions(assetId: string) {
  const prisma = getPrisma();
  const asset = await prisma.videoAsset.findFirst({
    where: { id: assetId },
    include: { renditions: { orderBy: { height: 'asc' } } },
  });
  if (!asset) throw new NotFoundError('Video asset not found');
  return asset.renditions;
}
