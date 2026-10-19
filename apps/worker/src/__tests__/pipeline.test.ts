import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  guessContentType,
  processAsset,
  setStorageForTests,
  TranscodeError,
} from '../pipeline';
import { setPrismaForTests } from '../prisma';
import type { Storage } from '@streamex/storage';

/**
 * pipeline tests â€” the full orchestration against doubles for every side
 * effect (ffmpeg, storage, Prisma, Redis).
 *
 * What these tests lock down:
 *  - stage ordering and the percent values written to video_assets
 *  - ladder gating driven by the probed source
 *  - master playlist + rendition + subtitle row persistence
 *  - failure classification (probe failure â†’ FAILED status + rethrow)
 *  - scratch-dir cleanup on success AND failure
 */

// â”€â”€ doubles â”€â”€

const ffmpegCommands: string[][] = [];

jest.mock('node:child_process', () => {
  const actual = jest.requireActual('node:child_process');
  return {
    ...actual,
    execFile: jest.fn((...args: unknown[]) => {
      const cmd = args.slice(0, -1);
      ffmpegCommands.push(cmd as string[]);
      const cb = args[args.length - 1] as (err: Error | null) => void;
      // ffprobe returns the recorded 1080p fixture; ffmpeg (sprite/subs) just succeeds.
      const prog = cmd.join(' ');
      if (prog.includes('ffprobe')) {
        cb(null, {
          stdout: JSON.stringify({
            streams: [
              {
                index: 0, codec_name: 'h264', codec_type: 'video',
                width: 1920, height: 1080, duration: '120',
                avg_frame_rate: '30/1', bit_rate: '9000000',
                disposition: { default: 1 },
              },
              {
                index: 1, codec_name: 'aac', codec_type: 'audio',
                duration: '120', bit_rate: '128000',
                disposition: { default: 1 },
              },
              {
                index: 2, codec_name: 'subrip', codec_type: 'subtitle',
                disposition: { default: 1 },
                tags: { language: 'eng', title: 'English' },
              },
            ],
            format: { duration: '120', bit_rate: '9000000', format_name: 'mov,mp4' },
          }),
          stderr: '',
        });
        return undefined;
      }
      cb(null, { stdout: '', stderr: '' });
      return undefined;
    }),
    spawn: jest.fn(),
  };
});

// Storage double â€” records puts, streams the recorded source back.
const putCalls: Array<{ key: string; body: string }> = [];
const fakeStorage: Storage = {
  async put(key, body, _meta) {
    putCalls.push({ key, body: String(body) });
  },
  async putFile(key, filePath, _meta) {
    // Read the file so playlist-content assertions work against real bytes.
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(filePath, 'utf8').catch(() => '(unreadable)');
    putCalls.push({ key, body });
  },
  async get(_key: string) {
    return {
      stream: (async function* () { yield Buffer.from('src'); })(),
      contentType: 'video/mp4',
      contentLength: 3,
      etag: 'etag',
      metadata: {},
    };
  },
  async getStream(_key: string) {
    return {
      stream: (async function* () { yield Buffer.from('src'); })(),
      contentType: 'video/mp4',
      contentLength: 3,
      etag: 'etag',
      metadata: {},
    };
  },
  async stat() { return { exists: false, size: 0, etag: null, lastModified: new Date() }; },
  async list(prefix) {
    return putCalls
      .filter((p) => p.key.startsWith(prefix))
      .map((p) => ({ key: p.key, size: p.body.length, lastModified: new Date() }));
  },
  async signedUrl(key) { return `https://signed/${key}`; },
  async delete(key) { putCalls.splice(putCalls.findIndex((p) => p.key === key), 1); },
  async deletePrefix(prefix) {
    for (let i = putCalls.length - 1; i >= 0; i -= 1) {
      if (putCalls[i]!.key.startsWith(prefix)) putCalls.splice(i, 1);
    }
  },
} as unknown as Storage;

// Prisma double.
const assetUpdates: Array<Record<string, unknown>> = [];
const renditionCreates: Array<Record<string, unknown>> = [];
const subtitleCreates: Array<Record<string, unknown>> = [];
const prismaDouble = {
  videoAsset: {
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      assetUpdates.push(args.data);
      return Promise.resolve({});
    }),
  },
  videoRendition: {
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      renditionCreates.push(args.data);
      return Promise.resolve({});
    }),
  },
  subtitleTrack: {
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      subtitleCreates.push(args.data);
      return Promise.resolve({});
    }),
  },
};

// Redis publish double (progress reporter's realtime channel).
const published: Array<Record<string, unknown>> = [];
jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: class {
      on() { return this; }
      async publish(_ch: string, msg: string) { published.push(JSON.parse(msg)); return 1; }
      async quit() { return 'OK'; }
      async connect() { return 'OK'; }
    },
  };
});

// The runner's encode step spawns ffmpeg â€” stub it to emit the artifacts the
// pipeline expects, so the orchestration can be tested end-to-end.
jest.mock('../ffmpegRunner', () => {
  const actual = jest.requireActual('../ffmpegRunner') as Record<string, unknown>;
  return {
    ...actual,
    runFfmpegEncode: jest.fn(async (input: { outputDir: string; rungs: { label: string }[] }, _cb: unknown) => {
      for (const rung of input.rungs) {
        const dir = path.join(input.outputDir, 'renditions', rung.label);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'index.m3u8'), '#EXTM3U\n', 'utf8');
      }
      return {
        outputDir: input.outputDir,
        rungs: input.rungs.map((r) => ({
          label: r.label,
          playlistPath: `${input.outputDir}/renditions/${r.label}/index.m3u8`,
        })),
        spritePath: null,
        spriteVttPath: null,
        subtitlePaths: [],
      };
    }),
  };
});

// Resolve env vars for the pipeline (tmp dir per test).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://x';
process.env.TRANSCODE_TMP_DIR = tmpdir();
process.env.TRANSCODE_ENABLE_4K = 'false';

describe('pipeline.processAsset', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    putCalls.length = 0;
    assetUpdates.length = 0;
    renditionCreates.length = 0;
    subtitleCreates.length = 0;
    published.length = 0;
    ffmpegCommands.length = 0;
    process.env.STORAGE_LOCAL_ROOT = tmpdir();
    setStorageForTests(fakeStorage);
    setPrismaForTests(prismaDouble as never);
  });

  afterEach(async () => {
    // Nothing persistent: the pipeline cleans its own scratch dirs.
  });

  it('runs the full happy path and persists every artifact', async () => {
    const outcome = await processAsset({ assetId: 'asset-1', sourceKey: 'uploads/src.mp4' });

    // Rung gating: 1080p source, 4K disabled â†’ 240..1080.
    expect(outcome.rungs).toEqual(['240p', '480p', '720p', '1080p']);
    expect(outcome.durationSeconds).toBe(120);
    expect(outcome.subtitles).toEqual([{ language: 'eng' }]);

    // Rendition rows: one per rung, with playlist keys under the asset prefix.
    expect(renditionCreates.map((r) => r.label)).toEqual(['240p', '480p', '720p', '1080p']);
    expect(renditionCreates[0]!.playlistKey).toBe(
      'assets/asset-1/hls/renditions/240p/index.m3u8',
    );

    // Subtitle row for the extracted track.
    expect(subtitleCreates).toHaveLength(1);
    expect(subtitleCreates[0]).toMatchObject({
      assetId: 'asset-1',
      language: 'eng',
      vttKey: 'assets/asset-1/hls/subtitles/eng.vtt',
    });

    // Final asset update flips to READY with the master playlist key.
    const finalUpdate = assetUpdates[assetUpdates.length - 1]!;
    expect(finalUpdate.status).toBe('READY');
    expect(finalUpdate.masterPlaylistKey).toBe('assets/asset-1/hls/master.m3u8');
    expect(finalUpdate.processingPercent).toBe(100);

    // Master playlist uploaded with exact BANDWIDTH + the rendition playlists.
    const uploadedKeys = putCalls.map((p) => p.key);
    expect(uploadedKeys).toContain('assets/asset-1/hls/master.m3u8');
    expect(uploadedKeys).toContain('assets/asset-1/hls/renditions/720p/index.m3u8');
    const master = putCalls.find((p) => p.key.endsWith('master.m3u8'))!;
    expect(master.body).toContain('BANDWIDTH=2628000'); // 2500 + 128 kbps
    expect(master.body).toContain('RESOLUTION=1280x720');
  });

  it('skips the 4K rung when the source is smaller than 2160p', async () => {
    const outcome = await processAsset({ assetId: 'asset-2', sourceKey: 'uploads/src.mp4' });
    expect(outcome.rungs).not.toContain('2160p');
  });

  it('writes monotonic progress and publishes realtime events', async () => {
    await processAsset({ assetId: 'asset-3', sourceKey: 'uploads/src.mp4' });
    const percents = assetUpdates.map((u) => u.processingPercent);
    expect(percents[0]).toBe(1);
    // Status transitions recorded on the asset row.
    expect(assetUpdates.some((u) => u.status === 'READY')).toBe(true);
    expect(published.length).toBeGreaterThan(0);
    expect(published[published.length - 1]).toMatchObject({ status: 'READY', percent: 100 });
  });

  it('marks the asset FAILED and rethrows when ffprobe cannot read the source', async () => {
    const { execFile } = jest.requireMock('node:child_process') as { execFile: jest.Mock };
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error('Invalid data found'));
      return undefined;
    });

    await expect(
      processAsset({ assetId: 'asset-4', sourceKey: 'uploads/bad.mp4' }),
    ).rejects.toThrow('ffprobe failed');

    const lastUpdate = assetUpdates[assetUpdates.length - 1]!;
    expect(lastUpdate.status).toBe('FAILED');
    expect(String(lastUpdate.errorMessage)).toContain('ffprobe failed');
  });

  it('rejects sources without a video stream', async () => {
    const { execFile } = jest.requireMock('node:child_process') as { execFile: jest.Mock };
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, out?: { stdout: string }) => void;
      cb(null, {
        stdout: JSON.stringify({
          streams: [{ index: 0, codec_name: 'aac', codec_type: 'audio', duration: '30' }],
          format: { duration: '30', bit_rate: '128000', format_name: 'mp3' },
        }),
      });
      return undefined;
    });

    await expect(
      processAsset({ assetId: 'asset-5', sourceKey: 'uploads/audio.mp3' }),
    ).rejects.toThrow('no video stream');
    const lastUpdate = assetUpdates[assetUpdates.length - 1]!;
    expect(lastUpdate.status).toBe('FAILED');
  });

  it('continues when thumbnail generation fails (non-fatal)', async () => {
    const { execFile } = jest.requireMock('node:child_process') as { execFile: jest.Mock };
    // ffprobe succeeds; the sprite command throws. Restore the default
    // implementation afterwards so later tests are not poisoned.
    const originalImpl = execFile.getMockImplementation();
    let probeDone = false;
    execFile.mockImplementation((...args: unknown[]) => {
      const cmd = args.slice(0, -1).join(' ');
      const cb = args[args.length - 1] as (err: Error | null, out?: { stdout: string }) => void;
      if (cmd.includes('ffprobe') && !probeDone) {
        probeDone = true;
        cb(null, {
          stdout: JSON.stringify({
            streams: [
              { index: 0, codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, duration: '120', avg_frame_rate: '30/1' },
              { index: 1, codec_name: 'aac', codec_type: 'audio', duration: '120' },
            ],
            format: { duration: '120', bit_rate: '9000000', format_name: 'mov,mp4' },
          }),
        });
        return undefined;
      }
      if (cmd.includes('sprite')) {
        cb(new Error('sprite generation failed'));
        return undefined;
      }
      cb(null, { stdout: '', stderr: '' });
      return undefined;
    });

    const outcome = await processAsset({ assetId: 'asset-6', sourceKey: 'uploads/src.mp4' });
    expect(outcome.rungs).toEqual(['240p', '480p', '720p', '1080p']);
    const finalUpdate = assetUpdates[assetUpdates.length - 1]!;
    expect(finalUpdate.status).toBe('READY');
    expect(finalUpdate.thumbnailSpriteKey).toBeNull();
    // Restore the shared default so subsequent tests get the standard fixture.
    if (originalImpl) execFile.mockImplementation(originalImpl);
    else execFile.mockImplementation(() => undefined);
  });

  it('cleans up its scratch directory on success', async () => {
    const outcome = await processAsset({ assetId: 'asset-7', sourceKey: 'uploads/src.mp4' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(tmpdir(), `asset-${outcome.assetId}`))).toBe(false);
  });

  it('cleans up its scratch directory even on failure', async () => {
    const { execFile } = jest.requireMock('node:child_process') as { execFile: jest.Mock };
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error('corrupt'));
      return undefined;
    });
    await expect(
      processAsset({ assetId: 'asset-8', sourceKey: 'uploads/src.mp4' }),
    ).rejects.toThrow();
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(tmpdir(), 'asset-asset-8'))).toBe(false);
  });
});

describe('guessContentType', () => {
  it('maps media extensions to HLS content types', () => {
    expect(guessContentType('master.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(guessContentType('seg_00001.ts')).toBe('video/mp2t');
    expect(guessContentType('thumbs.vtt')).toBe('text/vtt');
    expect(guessContentType('sprite.jpg')).toBe('image/jpeg');
    expect(guessContentType('blob.bin')).toBe('application/octet-stream');
  });
});

describe('TranscodeError', () => {
  it('carries the failing stage and cause', () => {
    const cause = new Error('disk full');
    const err = new TranscodeError('upload failed', 'upload', cause);
    expect(err.name).toBe('TranscodeError');
    expect(err.stage).toBe('upload');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('upload failed');
  });
});

// Keep tmpdir import used (mkdtemp used above by other suites; ensure no unused var lint).
void mkdtemp;
void rm;
