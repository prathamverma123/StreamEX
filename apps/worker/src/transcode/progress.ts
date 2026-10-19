/**
 * ffmpeg progress-line parsing.
 *
 * ffmpeg emits two progress formats:
 *
 * 1. Machine output (`-progress pipe:1`): `key=value` lines such as
 *    `out_time_us=4000000`. Consumed by ffmpegRunner's stdout handler.
 *
 * 2. The classic human stats line on stderr (emitted when -nostats is off):
 *    `frame=  120 fps= 60 q=28.0 size=    2048kB time=00:00:04.00
 *     bitrate=4194.3kbits/s speed=2.01x`
 *
 * This module parses format 2. It is kept separate from the runner so it can
 * be unit-tested against recorded ffmpeg output with no binary present.
 *
 * `parseFfmpegProgress` is pure: string in → struct out (or null for
 * non-progress lines). When a total duration is supplied, a clamped
 * `percent` is attached for DB/realtime reporting.
 */

export interface FfmpegProgress {
  /** Playback timestamp reached, in seconds. */
  timeSeconds: number;
  frame?: number;
  fps?: number;
  /** Encoder quantizer (-1 while copying / for audio-only passes). */
  q?: number;
  /** Output size in KiB — undefined when ffmpeg reports N/A. */
  sizeKb?: number;
  /** Bitrate in kbit/s — undefined when ffmpeg reports N/A. */
  bitrateKbps?: number;
  /** Encode speed relative to realtime, e.g. 2.01 for "2.01x". */
  speed?: number;
  /** 0..100 against a known duration, clamped. Present only when duration > 0. */
  percent?: number;
}

/** HH:MM:SS(.mmm) → seconds. Returns null when the shape doesn't match. */
export function parseTimecode(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return h * 3600 + m * 60 + s;
}

/** "2048kB" → 2048; "N/A" → undefined. */
function parseSizeKb(value: string): number | undefined {
  if (value === 'N/A' || value === '') return undefined;
  const match = /^(\d+(?:\.\d+)?)kB$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]);
}

/** "4194.3kbits/s" → 4194.3; "N/A" → undefined. */
function parseBitrate(value: string): number | undefined {
  if (value === 'N/A' || value === '') return undefined;
  const match = /^(\d+(?:\.\d+)?)kbits\/s$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]);
}

/** "2.01x" → 2.01; "N/A" → undefined. */
function parseSpeed(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)x$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]);
}

function numberOrUndefined(value: string): number | undefined {
  if (value === 'N/A' || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extract `key=value` pairs from an ffmpeg stats line. ffmpeg pads the value
 * with spaces (`frame=  120`), so the regex allows whitespace after `=`.
 */
const PAIR_RE = /(?:frame|fps|q|size|time|bitrate|speed|total_size|out_time|out_time_us|out_time_ms|progress)=\s*(\S*)/g;

/**
 * Parse one ffmpeg output line into a progress struct.
 *
 * Returns null for anything that is not a progress line (log chatter, the
 * "Press [q] to stop" banner, muxer messages, …). A line counts as progress
 * only when it carries a parseable `time=` field.
 *
 * @param line       one line of ffmpeg output (either format).
 * @param durationSeconds total source duration, enables `percent`.
 */
export function parseFfmpegProgress(
  line: string,
  durationSeconds?: number,
): FfmpegProgress | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const fields = new Map<string, string>();
  PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAIR_RE.exec(trimmed)) !== null) {
    const key = match[0].slice(0, match[0].indexOf('='));
    fields.set(key, match[1] ?? '');
  }

  const timeRaw = fields.get('time');
  if (timeRaw === undefined) return null;
  const timeSeconds = parseTimecode(timeRaw);
  if (timeSeconds === null) return null;

  const progress: FfmpegProgress = { timeSeconds };

  const frame = numberOrUndefined(fields.get('frame') ?? '');
  if (frame !== undefined) progress.frame = frame;

  const fps = numberOrUndefined(fields.get('fps') ?? '');
  if (fps !== undefined) progress.fps = fps;

  const q = numberOrUndefined(fields.get('q') ?? '');
  if (q !== undefined) progress.q = q;

  const sizeKb = parseSizeKb(fields.get('size') ?? '');
  if (sizeKb !== undefined) progress.sizeKb = sizeKb;

  const bitrate = parseBitrate(fields.get('bitrate') ?? '');
  if (bitrate !== undefined) progress.bitrateKbps = bitrate;

  const speed = parseSpeed(fields.get('speed') ?? '');
  if (speed !== undefined) progress.speed = speed;

  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    progress.percent = percentFromSeconds(timeSeconds, durationSeconds);
  }

  return progress;
}

/** Convert a reached-timestamp + total duration into a clamped percentage. */
export function percentFromSeconds(timeSeconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(100, (timeSeconds / durationSeconds) * 100));
}
