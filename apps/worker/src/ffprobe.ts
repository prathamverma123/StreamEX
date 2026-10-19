import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ffprobe wrapper — extracts source metadata.
 *
 * `parseFfprobe` is pure (takes a JSON string) so unit tests can feed
 * recorded fixture output without running ffprobe.
 */

export interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  disposition?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: {
    filename?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    format_name?: string;
    nb_streams?: number;
  };
}

export interface SourceInfo {
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number;
  container: string | null;
  bitrateBps: number;
  /** Embedded subtitle streams (with language + codec). */
  subtitleStreams: SubtitleStreamInfo[];
  hasAudio: boolean;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language: string;
  title: string | null;
  isDefault: boolean;
}

/** Build the ffprobe command line for a file. */
export function ffprobeArgs(filePath: string): string[] {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
}

/** Run ffprobe on disk. */
export async function probe(filePath: string): Promise<SourceInfo> {
  const { stdout } = await execFileAsync('ffprobe', ffprobeArgs(filePath), {
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseFfprobe(stdout);
}

/** Parse ffprobe JSON into the worker's SourceInfo shape. Pure + testable. */
export function parseFfprobe(json: string): SourceInfo {
  const parsed = JSON.parse(json) as ProbeResult;
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  const subs = parsed.streams.filter((s) => s.codec_type === 'subtitle');

  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  const durationSeconds = Number(parsed.format.duration ?? video?.duration ?? '0');
  const fps = parseFps(video?.avg_frame_rate ?? video?.r_frame_rate ?? '0/1');
  const bitrateBps = Number(parsed.format.bit_rate ?? '0');

  const subtitleStreams: SubtitleStreamInfo[] = subs.map((s) => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    language: s.tags?.language ?? 'und',
    title: s.tags?.title ?? null,
    isDefault: Boolean(s.disposition?.default),
  }));

  return {
    width,
    height,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    fps,
    container: parsed.format.format_name?.split(',')[0] ?? null,
    bitrateBps: Number.isFinite(bitrateBps) ? bitrateBps : 0,
    subtitleStreams,
    hasAudio: Boolean(audio),
  };
}

/** "30000/1001" → 29.97 */
export function parseFps(rate: string): number {
  const [num, den] = rate.split('/');
  const n = Number(num ?? 0);
  const d = Number(den ?? 1);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  const fps = n / d;
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0;
}
