import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadWorkerEnv } from './config/env.js';
import { buildFfmpegPlan, buildSpriteArgs, buildSubtitleArgs, type BuildPlanInput } from './ffmpeg.js';
import { buildSpriteEntries, buildThumbnailVtt, formatTimestamp } from './playlist.js';
import { parseFfmpegProgress, percentFromSeconds } from './transcode/progress.js';
import type { LadderRung } from './ladder.js';
import type { SourceInfo } from './ffprobe.js';

const execFileAsync = promisify(execFile);

/**
 * ffmpeg orchestration — runs the encode, reports progress.
 *
 * Progress: ffmpeg writes `out_time_ms` on stdout (via -progress pipe:1); the
 * parser turns that into a percentage of the known duration and calls the
 * callback, which the pipeline uses to update video_assets.processing_percent
 * and to publish realtime events.
 */

export interface EncodeResult {
  outputDir: string;
  rungs: { label: string; playlistPath: string }[];
  spritePath: string | null;
  spriteVttPath: string | null;
  subtitlePaths: { language: string; path: string }[];
}

export interface EncodeCallbacks {
  onProgress?: (percent: number, message: string) => void;
}

/** Parse ffmpeg's -progress output lines into a progress object. */
export function parseProgressLine(line: string): { key: string; value: string } | null {
  const match = /^([a-zA-Z_]+)=(.*)$/.exec(line.trim());
  if (!match) return null;
  return { key: match[1]!, value: match[2]! };
}

/** Convert out_time_ms + duration → 0..100 percentage. */
export function percentFromOutTime(outTimeUs: number, durationSeconds: number): number {
  return percentFromSeconds(outTimeUs / 1_000_000, durationSeconds);
}

export async function runFfmpegEncode(
  input: BuildPlanInput & { durationSeconds: number },
  callbacks?: EncodeCallbacks,
): Promise<EncodeResult> {
  const plan = buildFfmpegPlan(input);
  callbacks?.onProgress?.(1, 'encoding started');

  // -progress pipe:1 → parse stdout incrementally.
  const args = [...plan.args];
  // Insert the progress reporter right after the input.
  const inputIndex = args.indexOf('-i');
  args.splice(inputIndex + 2, 0, '-progress', 'pipe:1', '-nostats');

  await execFfmpegStreaming(
    args,
    (pct) => callbacks?.onProgress?.(pct, 'encoding'),
    input.durationSeconds,
  );

  callbacks?.onProgress?.(95, 'writing master playlist');

  const rungs = plan.rungLabels.map((label) => ({
    label,
    playlistPath: `${plan.outputDir}/renditions/${label}/index.m3u8`,
  }));

  return {
    outputDir: plan.outputDir,
    rungs,
    spritePath: null,
    spriteVttPath: null,
    subtitlePaths: [],
  };
}

async function execFfmpegStreaming(
  args: string[],
  onPercent: (percent: number) => void,
  durationSeconds: number,
): Promise<void> {
  const { spawn } = await import('node:child_process');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let lastPercent = 0;
    // Monotonic guard: stdout (-progress pipe) and stderr (stats lines) both
    // report; only forward forward-movement so the two never fight.
    const report = (pct: number) => {
      if (pct > lastPercent) {
        lastPercent = pct;
        onPercent(pct);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const parsed = parseProgressLine(line);
        if (parsed?.key === 'out_time_us' || parsed?.key === 'out_time_ms') {
          const value = Number(parsed.value);
          if (Number.isFinite(value)) {
            report(percentFromOutTime(value, durationSeconds));
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      // Fallback channel: classic "frame= ... time=..." stats lines (only
      // emitted when -nostats is off). stdout remains the primary source.
      for (const line of text.split('\n')) {
        const progress = parseFfmpegProgress(line, durationSeconds);
        if (progress?.percent !== undefined) report(progress.percent);
      }
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail}`));
    });
  });
}

/** Thumbnails: sprite sheet + VTT index. */
export async function generateThumbnails(
  input: {
    inputPath: string;
    outputDir: string;
    durationSeconds: number;
  },
  callbacks?: EncodeCallbacks,
): Promise<{ spritePath: string; spriteVttPath: string; entries: number }> {
  const env = loadWorkerEnv();
  const interval = env.SPRITE_FRAME_INTERVAL_SECONDS;
  const tileW = env.SPRITE_TILE_WIDTH;
  const tileH = env.SPRITE_TILE_HEIGHT;
  const maxTiles = tileW * tileH;

  const args = buildSpriteArgs({
    inputPath: input.inputPath,
    outputDir: input.outputDir,
    intervalSeconds: interval,
    tileWidth: tileW,
    tileHeight: tileH,
    durationSeconds: input.durationSeconds,
  });
  await execFileAsync('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });
  callbacks?.onProgress?.(97, 'thumbnails generated');

  // VTT index.
  const entries = buildSpriteEntries(input.durationSeconds, interval, maxTiles);
  const vtt = buildThumbnailVtt(entries, {
    tileWidth: tileW,
    tilePixelWidth: 160,
    tilePixelHeight: 90,
    spriteUri: 'sprite.jpg',
  });
  const vttPath = `${input.outputDir}/thumbs.vtt`;
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(vttPath, vtt, 'utf8');
  return { spritePath: `${input.outputDir}/sprite.jpg`, spriteVttPath: vttPath, entries: entries.length };
}

/** Subtitle extraction: embedded streams → WebVTT. */
export async function extractSubtitles(
  input: {
    inputPath: string;
    outputDir: string;
    streams: SourceInfo['subtitleStreams'];
  },
): Promise<{ language: string; path: string; title: string | null; isDefault: boolean }[]> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(`${input.outputDir}/subtitles`, { recursive: true });
  const commands = buildSubtitleArgs({
    inputPath: input.inputPath,
    outputDir: input.outputDir,
    streams: input.streams,
  });
  const results: { language: string; path: string; title: string | null; isDefault: boolean }[] = [];
  let i = 0;
  for (const cmd of commands) {
    try {
      await execFileAsync('ffmpeg', cmd, { maxBuffer: 10 * 1024 * 1024 });
      const stream = input.streams[i]!;
      results.push({
        language: stream.language,
        path: `${input.outputDir}/subtitles/${stream.language}.vtt`,
        title: stream.title,
        isDefault: stream.isDefault,
      });
    } catch {
      // A single bad subtitle stream must not fail the whole job.
    }
    i += 1;
  }
  return results;
}

/** Convenience re-export for tests. */
export { formatTimestamp };
