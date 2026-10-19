import type { LadderRung } from './ladder.js';

/**
 * Master playlist (m3u8) writer.
 *
 * ffmpeg's built-in master playlist works, but we write our own so the
 * BANDWIDTH values are exact (video + audio), CODECS are declared, and the
 * rendition URIs match the storage layout the API serves.
 *
 * Pure string building — fully unit-testable.
 */

export interface MasterPlaylistInput {
  rungs: LadderRung[];
  /** URI for each rendition playlist, same order as rungs. */
  renditionUris: string[];
  /** Codec strings for the CODECS attribute, e.g. "avc1.640028,mp4a.40.2". */
  codecs?: string[];
}

export function buildMasterPlaylist(input: MasterPlaylistInput): string {
  if (input.rungs.length !== input.renditionUris.length) {
    throw new Error('rungs and renditionUris must have the same length');
  }
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3'];

  // Audio group declaration (single AAC rendition shared by all video rungs).
  const hasAudio = input.rungs.some((r) => r.audioBitrateKbps > 0);
  if (hasAudio) {
    lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en"');
  }

  input.rungs.forEach((rung, i) => {
    const bandwidth = (rung.videoBitrateKbps + rung.audioBitrateKbps) * 1000;
    const codecs =
      input.codecs?.[i] ?? 'avc1.640028,mp4a.40.2';
    const audioPart = hasAudio ? ',AUDIO="audio"' : '';
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rung.width}x${rung.height},CODECS="${codecs}"${audioPart}`,
      input.renditionUris[i]!,
    );
  });

  return lines.join('\n') + '\n';
}

export interface SpriteVttEntry {
  /** Sprite tile index (0-based). */
  index: number;
  /** Start time of the interval, seconds. */
  startSeconds: number;
  /** End time of the interval, seconds. */
  endSeconds: number;
}

/**
 * WebVTT index for the scrubbing sprite. The player maps currentTime → tile
 * index → sprite coordinates (this is the standard approach hls.js / Shaka
 * use for thumbnail tracks).
 */
export function buildThumbnailVtt(
  entries: SpriteVttEntry[],
  options: { tileWidth: number; tilePixelWidth: number; tilePixelHeight: number; spriteUri: string },
): string {
  const lines: string[] = ['WEBVTT', ''];
  entries.forEach((entry) => {
    const col = entry.index % options.tileWidth;
    const row = Math.floor(entry.index / options.tileWidth);
    const t1 = formatTimestamp(entry.startSeconds);
    const t2 = formatTimestamp(entry.endSeconds);
    lines.push(
      `${t1} --> ${t2}`,
      `${options.spriteUri}#xywh=${col * options.tilePixelWidth},${row * options.tilePixelHeight},${options.tilePixelWidth},${options.tilePixelHeight}`,
      '',
    );
  });
  return lines.join('\n');
}

/** 65.4 → "00:01:05.400" */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** Entries for the whole duration — one per sprite interval. */
export function buildSpriteEntries(
  durationSeconds: number,
  intervalSeconds: number,
  maxTiles: number,
): SpriteVttEntry[] {
  const entries: SpriteVttEntry[] = [];
  const total = Math.max(1, Math.ceil(durationSeconds / intervalSeconds));
  for (let i = 0; i < total && i < maxTiles; i += 1) {
    entries.push({
      index: i,
      startSeconds: i * intervalSeconds,
      endSeconds: Math.min(durationSeconds, (i + 1) * intervalSeconds),
    });
  }
  return entries;
}
