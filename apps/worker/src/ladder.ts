import { loadWorkerEnv } from './config/env.js';

/**
 * Encoding ladder builder.
 *
 * The default ladder (see docs/ARCHITECTURE.md § adaptive bitrate):
 *   240p  @ 400 kbps
 *   480p  @ 1000 kbps
 *   720p  @ 2500 kbps
 *   1080p @ 5000 kbps
 *   2160p @ 15000 kbps (4K — only when the source is big enough AND enabled)
 *
 * Rung selection rules:
 *   1. A rung is included only when its height ≤ source height (never upscale).
 *   2. The top rung never exceeds the source bitrate by more than 50% —
 *      re-encoding at a higher bitrate than the source wastes storage.
 *   3. 2160p additionally requires TRANSCODE_ENABLE_4K=true.
 *   4. At least one rung always survives (the lowest), so playback works even
 *      for tiny sources.
 */

export interface LadderRung {
  height: number;
  width: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  label: string;
}

export interface LadderOptions {
  ladderSpec?: string;
  sourceHeight: number;
  sourceWidth: number;
  sourceBitrateKbps: number;
  audioBitrateKbps?: number;
  enable4k?: boolean;
}

/** Parse "240:400,480:1000,..." into rung tuples. */
export function parseLadderSpec(spec: string): { height: number; videoBitrateKbps: number }[] {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [height, bitrate] = entry.split(':');
      const h = Number(height);
      const b = Number(bitrate);
      if (!Number.isFinite(h) || !Number.isFinite(b) || h <= 0 || b <= 0) {
        throw new Error(`Invalid ladder entry: ${entry}`);
      }
      return { height: h, videoBitrateKbps: b };
    })
    .sort((a, b) => a.height - b.height);
}

/** Aspect-ratio-preserving width for a target height (even numbers only). */
export function widthForHeight(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
  if (sourceHeight <= 0 || sourceWidth <= 0) return Math.round((targetHeight * 16) / 9);
  const w = (sourceWidth / sourceHeight) * targetHeight;
  // h264 requires even dimensions.
  return Math.max(2, Math.round(w / 2) * 2);
}

export function buildLadder(options: LadderOptions): LadderRung[] {
  const env = loadWorkerEnv();
  const spec = options.ladderSpec ?? env.TRANSCODE_LADDER;
  const audioKbps = options.audioBitrateKbps ?? env.TRANSCODE_AUDIO_BITRATE_KBPS;
  const enable4k = options.enable4k ?? env.TRANSCODE_ENABLE_4K;

  const parsed = parseLadderSpec(spec);
  if (parsed.length === 0) throw new Error('Empty encoding ladder');

  const rungs: LadderRung[] = [];
  for (const rung of parsed) {
    // 4K gating.
    if (rung.height >= 2160 && !enable4k) continue;
    // Never upscale.
    if (rung.height > options.sourceHeight) continue;
    // The top rung shouldn't massively exceed the source bitrate.
    if (
      rungs.length > 0 &&
      rung.videoBitrateKbps > options.sourceBitrateKbps * 1.5 &&
      rung.height === Math.max(...parsed.map((p) => p.height))
    ) {
      continue;
    }
    rungs.push({
      height: rung.height,
      width: widthForHeight(options.sourceWidth, options.sourceHeight, rung.height),
      videoBitrateKbps: rung.videoBitrateKbps,
      audioBitrateKbps: audioKbps,
      label: `${rung.height}p`,
    });
  }

  // Guarantee at least one rung: fall back to the smallest parsed rung,
  // clamped to the source height.
  if (rungs.length === 0) {
    const smallest = parsed[0]!;
    const height = Math.min(smallest.height, Math.max(2, options.sourceHeight));
    rungs.push({
      height,
      width: widthForHeight(options.sourceWidth, options.sourceHeight, height),
      videoBitrateKbps: smallest.videoBitrateKbps,
      audioBitrateKbps: audioKbps,
      label: `${height}p`,
    });
  }

  return rungs.sort((a, b) => a.height - b.height);
}

/** Total bitrate of a rung — used for master playlist BANDWIDTH tags. */
export function totalBitrateKbps(rung: LadderRung): number {
  return rung.videoBitrateKbps + rung.audioBitrateKbps;
}
