import {
  parseProgressLine,
  percentFromOutTime,
  runFfmpegEncode,
  generateThumbnails,
  extractSubtitles,
} from '../ffmpegRunner';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LadderRung } from '../ladder';
import type { SourceInfo } from '../ffprobe';

/**
 * ffmpegRunner tests.
 *
 * The runner shells out to the real ffmpeg, which is not guaranteed on CI.
 * Process-spawning paths are therefore exercised against a stubbed child
 * process module; everything else (argument construction, progress parsing,
 * filesystem effects) runs for real against a temp dir.
 */

jest.mock('node:child_process', () => {
  const actual = jest.requireActual('node:child_process');
  return {
    ...actual,
    execFile: jest.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null, { stdout: '', stderr: '' });
      return undefined;
    }),
    spawn: jest.fn(),
  };
});

const rung = (height: number, videoKbps: number): LadderRung => ({
  height,
  width: Math.round((height * 16) / 9 / 2) * 2,
  videoBitrateKbps: videoKbps,
  audioBitrateKbps: 128,
  label: `${height}p`,
});

const source = (overrides: Partial<SourceInfo> = {}): SourceInfo => ({
  width: 1280,
  height: 720,
  durationSeconds: 120,
  videoCodec: 'h264',
  audioCodec: 'aac',
  fps: 30,
  container: 'mp4',
  bitrateBps: 3_000_000,
  subtitleStreams: [],
  hasAudio: true,
  ...overrides,
});

describe('parseProgressLine', () => {
  it('splits key=value pairs', () => {
    expect(parseProgressLine('out_time_us=4000000')).toEqual({
      key: 'out_time_us',
      value: '4000000',
    });
  });

  it('returns null for lines that are not a single key=value pair', () => {
    expect(parseProgressLine('[hls @ 0x1] Opening file for writing')).toBeNull();
    expect(parseProgressLine('Press [q] to stop')).toBeNull();
    expect(parseProgressLine('Progress: 42%')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
  });
});

describe('percentFromOutTime', () => {
  it('converts microseconds to a clamped percentage', () => {
    expect(percentFromOutTime(60_000_000, 120)).toBe(50);
  });

  it('clamps to 0 when duration is unknown', () => {
    expect(percentFromOutTime(1000, 0)).toBe(0);
  });

  it('never exceeds 100', () => {
    expect(percentFromOutTime(10_000_000_000, 100)).toBe(100);
  });
});

describe('runFfmpegEncode (stubbed child process)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'streamex-runner-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('parses -progress stdout into monotonic percent callbacks', async () => {
    const { spawn } = jest.requireMock('node:child_process') as { spawn: jest.Mock };
    // NOTE: no numeric separators — the parser feeds these to Number().
    spawn.mockImplementationOnce(() => makeFakeChild(['out_time_us=60000000']));

    const percents: number[] = [];
    const result = await runFfmpegEncode(
      {
        inputPath: path.join(workDir, 'source.mp4'),
        outputDir: workDir,
        rungs: [rung(480, 1000)],
        source: source(),
        durationSeconds: 120,
      },
      { onProgress: (pct) => percents.push(pct) },
    );

    // 60s of 120s → 50% from the stdout pipe; 1 (start) and 95 (post-encode)
    // markers frame the real progress values.
    expect(percents).toEqual([1, 50, 95]);
    expect(result.rungs[0]).toEqual({
      label: '480p',
      // Built with a forward-slash literal — it feeds straight into argv.
      playlistPath: `${workDir}/renditions/480p/index.m3u8`,
    });
  });

  it('ignores backward progress and duplicate callbacks', async () => {
    const { spawn } = jest.requireMock('node:child_process') as { spawn: jest.Mock };
    spawn.mockImplementationOnce(() =>
      makeFakeChild(['out_time_us=60000000', 'out_time_us=30000000', 'out_time_us=60000000']),
    );

    const percents: number[] = [];
    await runFfmpegEncode(
      {
        inputPath: path.join(workDir, 'source.mp4'),
        outputDir: workDir,
        rungs: [rung(480, 1000)],
        source: source(),
        durationSeconds: 120,
      },
      { onProgress: (pct) => percents.push(pct) },
    );

    // Out-of-order and duplicate timestamps must not regress the reported
    // percentage: only 50 (60s/120s) ever lands, bracketed by 1 and 95.
    expect(percents).toEqual([1, 50, 95]);
  });

  it('rejects when ffmpeg exits non-zero and surfaces the stderr tail', async () => {
    const { spawn } = jest.requireMock('node:child_process') as { spawn: jest.Mock };
    spawn.mockImplementationOnce(() => makeFakeChild([], 'boom', 1));

    await expect(
      runFfmpegEncode({
        inputPath: path.join(workDir, 'source.mp4'),
        outputDir: workDir,
        rungs: [rung(480, 1000)],
        source: source(),
        durationSeconds: 120,
      }),
    ).rejects.toThrow('ffmpeg exited with code 1');
  });

  it('rejects when ffmpeg cannot be spawned', async () => {
    const { spawn } = jest.requireMock('node:child_process') as { spawn: jest.Mock };
    spawn.mockImplementationOnce(() => makeFakeChild([], undefined, undefined, new Error('ENOENT')));
    await expect(
      runFfmpegEncode({
        inputPath: path.join(workDir, 'source.mp4'),
        outputDir: workDir,
        rungs: [rung(480, 1000)],
        source: source(),
        durationSeconds: 120,
      }),
    ).rejects.toThrow('ENOENT');
  });
});

describe('generateThumbnails (stubbed execFile)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'streamex-thumbs-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('writes the sprite VTT index with tiled coordinates', async () => {
    const result = await generateThumbnails({
      inputPath: path.join(workDir, 'source.mp4'),
      outputDir: workDir,
      durationSeconds: 100,
    });
    expect(result.entries).toBe(10);
    // The runner builds artifact paths with forward-slash literals (they feed
    // straight into ffmpeg argv), so compare against the same construction.
    expect(result.spritePath).toBe(`${workDir}/sprite.jpg`);
    expect(result.spriteVttPath).toBe(`${workDir}/thumbs.vtt`);
    const vtt = await readFile(result.spriteVttPath!);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('#xywh=0,0,160,90');
    expect(vtt).toContain('#xywh=160,0,160,90');
    expect(vtt).toContain('00:00:00.000 --> 00:00:10.000');
    expect(vtt).toContain('00:00:30.000 --> 00:00:40.000');
  });

  it('caps entries at the tile capacity', async () => {
    const result = await generateThumbnails({
      inputPath: path.join(workDir, 'source.mp4'),
      outputDir: workDir,
      durationSeconds: 100_000,
    });
    expect(result.entries).toBe(100); // 10x10 sprite
  });

  it('always emits at least one entry', async () => {
    const result = await generateThumbnails({
      inputPath: path.join(workDir, 'source.mp4'),
      outputDir: workDir,
      durationSeconds: 0,
    });
    expect(result.entries).toBe(1);
  });
});

describe('extractSubtitles (stubbed execFile)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'streamex-subs-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('extracts every text stream to a per-language VTT', async () => {
    const results = await extractSubtitles({
      inputPath: path.join(workDir, 'source.mkv'),
      outputDir: workDir,
      streams: [
        { index: 3, language: 'eng', codec: 'subrip', title: 'English', isDefault: true },
        { index: 4, language: 'deu', codec: 'subrip', title: 'Deutsch', isDefault: false },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ language: 'eng', isDefault: true, title: 'English' });
    expect(path.normalize(results[0]!.path).endsWith(path.join('subtitles', 'eng.vtt'))).toBe(true);
    expect(path.normalize(results[1]!.path).endsWith(path.join('subtitles', 'deu.vtt'))).toBe(true);
  });

  it('skips image-based streams entirely', async () => {
    const results = await extractSubtitles({
      inputPath: path.join(workDir, 'source.mkv'),
      outputDir: workDir,
      streams: [
        { index: 5, language: 'eng', codec: 'hdmv_pgs_subtitle', title: null, isDefault: false },
      ],
    });
    expect(results).toHaveLength(0);
  });

  it('survives a failing stream without failing the job', async () => {
    const { execFile } = jest.requireMock('node:child_process') as { execFile: jest.Mock };
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error('corrupt subtitle stream'));
      return undefined;
    });
    const results = await extractSubtitles({
      inputPath: path.join(workDir, 'source.mkv'),
      outputDir: workDir,
      streams: [
        { index: 3, language: 'eng', codec: 'subrip', title: null, isDefault: false },
        { index: 4, language: 'deu', codec: 'subrip', title: null, isDefault: false },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.language).toBe('deu');
  });
});

// ── test doubles ──

interface FakeChild {
  stdout: { on(event: string, cb: (chunk: Buffer) => void): void };
  stderr: { on(event: string, cb: (chunk: Buffer) => void): void };
  on(event: string, cb: (arg: unknown) => void): void;
}

function makeFakeChild(
  stdoutLines: string[],
  stderrText = '',
  exitCode?: number,
  spawnError?: Error,
): FakeChild {
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const stdout = { on: (_: string, cb: (chunk: Buffer) => void) => { (listeners.stdout ??= []).push(cb); } };
  const stderr = { on: (_: string, cb: (chunk: Buffer) => void) => { (listeners.stderr ??= []).push(cb); } };
  const child: FakeChild = {
    stdout,
    stderr,
    on(event, cb) { (listeners[event] ??= []).push(cb); },
  };
  queueMicrotask(() => {
    if (spawnError) {
      listeners['error']?.[0]?.(spawnError);
      return;
    }
    if (stdoutLines.length > 0) {
      listeners.stdout?.[0]?.(Buffer.from(stdoutLines.join('\n') + '\n'));
    }
    if (stderrText) listeners.stderr?.[0]?.(Buffer.from(stderrText));
    listeners['close']?.[0]?.(exitCode ?? 0);
  });
  return child;
}

async function readFile(p: string): Promise<string> {
  const { readFile: rf } = await import('node:fs/promises');
  return rf(p, 'utf8');
}
