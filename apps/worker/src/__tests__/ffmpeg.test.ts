import { describe, it, expect, beforeEach } from '@jest/globals';
import { buildFfmpegPlan, buildSpriteArgs, buildVarStreamMap } from '../ffmpeg';
import type { LadderRung } from '../ladder';
import type { SourceInfo } from '../ffprobe';

/**
 * Command construction tests — assert the exact ffmpeg argv so the
 * keyframe-alignment and HLS contracts are locked in.
 */

const rung = (height: number, videoKbps: number, width?: number): LadderRung => ({
  height,
  width: width ?? Math.round((height * 16) / 9 / 2) * 2,
  videoBitrateKbps: videoKbps,
  audioBitrateKbps: 128,
  label: `${height}p`,
});

const source = (overrides: Partial<SourceInfo> = {}): SourceInfo => ({
  width: 1920,
  height: 1080,
  durationSeconds: 600,
  videoCodec: 'h264',
  audioCodec: 'aac',
  fps: 30,
  container: 'mov',
  bitrateBps: 9_000_000,
  subtitleStreams: [],
  hasAudio: true,
  ...overrides,
});

describe('buildFfmpegPlan', () => {
  beforeEach(() => {
    process.env.TRANSCODE_HLS_SECONDS = '2';
    process.env.TRANSCODE_KEYFRAME_SECONDS = '2';
    process.env.TRANSCODE_VIDEO_CODEC = 'libx264';
    process.env.TRANSCODE_AUDIO_CODEC = 'aac';
    process.env.TRANSCODE_X264_PRESET = 'medium';
    process.env.TRANSCODE_AUDIO_BITRATE_KBPS = '128';
  });

  it('starts with -y and the input', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/work/source.mkv',
      outputDir: '/work/hls',
      rungs: [rung(720, 2500)],
      source: source(),
    });
    expect(plan.args[0]).toBe('-y');
    expect(plan.args[1]).toBe('-i');
    expect(plan.args[2]).toBe('/work/source.mkv');
  });

  it('throws when no rungs are provided', () => {
    expect(() =>
      buildFfmpegPlan({
        inputPath: '/src',
        outputDir: '/out',
        rungs: [],
        source: source(),
      }),
    ).toThrow('No rungs to encode');
  });

  it('rejects hls/keyframe mismatch that would break segment alignment', () => {
    expect(() =>
      buildFfmpegPlan({
        inputPath: '/src',
        outputDir: '/out',
        rungs: [rung(720, 2500)],
        source: source(),
        hlsSeconds: 4,
        keyframeSeconds: 2,
      }),
    ).toThrow('must equal');
  });

  it('uses one filter_complex with a scale+pad branch per rung', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(240, 400), rung(480, 1000)],
      source: source(),
    });
    const fcIndex = plan.args.indexOf('-filter_complex');
    expect(fcIndex).toBeGreaterThan(0);
    const filter = plan.args[fcIndex + 1]!;
    // One branch per rung, joined by ';'.
    expect(filter.split(';')).toHaveLength(2);
    expect(filter).toContain('[v0]');
    expect(filter).toContain('[v1]');
    expect(filter).toContain('scale=w=426:h=240');
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(filter).toContain('setsar=1');
  });

  it('pads to even dimensions for h264 compliance', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(480, 1000, 854)],
      source: source(),
    });
    const filter = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  });

  it('maps audio only when the source has an audio stream', () => {
    const withAudio = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(480, 1000)],
      source: source(),
    });
    expect(withAudio.args).toContain('-map');
    expect(withAudio.args).toContain('0:a:0');

    const silent = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(480, 1000)],
      source: source({ hasAudio: false, audioCodec: null }),
    });
    expect(silent.args).toContain('-an');
    expect(silent.args).not.toContain('0:a:0');
  });

  it('sets per-rung encoder parameters with maxrate 1.07x and bufsize 1.5x', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(720, 2500)],
      source: source(),
    });
    expect(plan.args).toContain('-b:v:0');
    expect(plan.args[plan.args.indexOf('-b:v:0') + 1]).toBe('2500k');
    expect(plan.args[plan.args.indexOf('-maxrate:v:0') + 1]).toBe('2675k');
    expect(plan.args[plan.args.indexOf('-bufsize:v:0') + 1]).toBe('3750k');
  });

  it('uses the high profile for 1080p+ and main below', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(480, 1000), rung(1080, 5000)],
      source: source(),
    });
    expect(plan.args[plan.args.indexOf('-profile:v:0') + 1]).toBe('main');
    expect(plan.args[plan.args.indexOf('-profile:v:1') + 1]).toBe('high');
  });

  it('applies identical GOP settings to every rung for keyframe alignment', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(240, 400), rung(480, 1000), rung(720, 2500)],
      source: source({ fps: 30 }),
    });
    // force_key_frames once, shared by all branches.
    expect(plan.args.filter((a) => a === '-force_key_frames')).toHaveLength(1);
    expect(plan.args[plan.args.indexOf('-force_key_frames') + 1]).toBe(
      'expr:gte(t,n_forced*2)',
    );
    // GOP = keyframeSeconds * fps, uniform across rungs.
    expect(plan.args[plan.args.indexOf('-g') + 1]).toBe('60');
    expect(plan.args[plan.args.indexOf('-keyint_min') + 1]).toBe('60');
    expect(plan.args).toContain('-sc_threshold');
    expect(plan.args[plan.args.indexOf('-sc_threshold') + 1]).toBe('0');
    expect(plan.args).toContain('-pix_fmt');
    expect(plan.args[plan.args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });

  it('falls back to 30fps for GOP size when the source fps is unknown', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(480, 1000)],
      source: source({ fps: 0 }),
    });
    expect(plan.args[plan.args.indexOf('-g') + 1]).toBe('60');
  });

  it('muxes HLS with independent segments and the rung names', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(240, 400), rung(480, 1000)],
      source: source(),
    });
    expect(plan.args).toContain('-f');
    expect(plan.args[plan.args.indexOf('-f') + 1]).toBe('hls');
    expect(plan.args[plan.args.indexOf('-hls_time') + 1]).toBe('2');
    expect(plan.args).toContain('-hls_playlist_type');
    expect(plan.args[plan.args.indexOf('-hls_playlist_type') + 1]).toBe('vod');
    expect(plan.args[plan.args.indexOf('-hls_flags') + 1]).toBe(
      'independent_segments+append_list',
    );
    expect(plan.args).toContain('-hls_segment_filename');
    expect(plan.args[plan.args.indexOf('-hls_segment_filename') + 1]).toBe(
      '/out/renditions/%v/seg_%05d.ts',
    );
    expect(plan.args[plan.args.indexOf('-master_pl_name') + 1]).toBe('master.m3u8');
    const vsm = plan.args[plan.args.indexOf('-var_stream_map') + 1]!;
    expect(vsm).toBe('v:0,a:0,name:240p v:1,a:1,name:480p');
    expect(plan.args.at(-1)).toBe('/out/%v.m3u8');
  });

  it('reports the rung labels it encoded', () => {
    const plan = buildFfmpegPlan({
      inputPath: '/src',
      outputDir: '/out',
      rungs: [rung(240, 400), rung(480, 1000)],
      source: source(),
    });
    expect(plan.rungLabels).toEqual(['240p', '480p']);
  });
});

describe('buildVarStreamMap', () => {
  it('maps audio for each rung when audio exists', () => {
    expect(buildVarStreamMap([rung(240, 400)], true)).toBe('v:0,a:0,name:240p');
  });

  it('omits audio when the source is silent', () => {
    expect(buildVarStreamMap([rung(240, 400)], false)).toBe('v:0,name:240p');
  });
});

describe('buildSpriteArgs', () => {
  it('tiles one frame per interval into a grid', () => {
    const args = buildSpriteArgs({
      inputPath: '/src.mp4',
      outputDir: '/out',
      intervalSeconds: 10,
      tileWidth: 10,
      tileHeight: 10,
      durationSeconds: 600,
    });
    expect(args[0]).toBe('-y');
    expect(args).toContain('-i');
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('fps=0.1');
    expect(vf).toContain('scale=160:90');
    expect(vf).toContain('tile=10x10:padding=2:color=black');
    expect(args.at(-1)).toBe('/out/sprite.jpg');
  });

  it('emits at least one frame for short clips', () => {
    const args = buildSpriteArgs({
      inputPath: '/src.mp4',
      outputDir: '/out',
      intervalSeconds: 10,
      tileWidth: 10,
      tileHeight: 10,
      durationSeconds: 5,
    });
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
  });

  it('supports custom tile pixel sizes', () => {
    const args = buildSpriteArgs({
      inputPath: '/src.mp4',
      outputDir: '/out',
      intervalSeconds: 10,
      tileWidth: 5,
      tileHeight: 5,
      durationSeconds: 5000,
      tilePixelWidth: 320,
      tilePixelHeight: 180,
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('scale=320:180');
  });
});
