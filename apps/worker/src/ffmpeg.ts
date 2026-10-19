import { loadWorkerEnv } from './config/env.js';
import type { LadderRung } from './ladder.js';
import type { SourceInfo } from './ffprobe.js';

/**
 * ffmpeg command construction for multi-bitrate HLS.
 *
 * Key design points (see docs/ARCHITECTURE.md § adaptive bitrate strategy):
 *
 * 1. ONE ffmpeg invocation encodes every rung via filter_complex — the input
 *    is decoded once and split N ways, which is dramatically faster than N
 *    separate processes (and keeps the audio in sync).
 *
 * 2. Keyframe alignment: every rung gets `-force_key_frames
 *    "expr:gte(t,n_forced*2)"` with the SAME GOP length. Because every rung
 *    starts its GOPs at identical timestamps, segment boundaries land on the
 *    same timestamps across rungs — the requirement for clean ABR switching.
 *
 * 3. `-hls_time 2` + `-hls_flags independent_segments` ensures each segment
 *    decodes standalone.
 *
 * 4. The scaler uses lanczos with a `force_original_aspect_ratio=decrease` +
 *    `pad` chain so odd aspect ratios don't distort.
 *
 * 5. Audio: single AAC track per rung (the player muxes it).
 */

export interface FfmpegPlan {
  args: string[];
  outputDir: string;
  rungLabels: string[];
}

export interface BuildPlanInput {
  inputPath: string;
  outputDir: string;
  rungs: LadderRung[];
  source: SourceInfo;
  /** Segment duration — must equal the GOP length for aligned boundaries. */
  hlsSeconds?: number;
  keyframeSeconds?: number;
  videoCodec?: string;
  audioCodec?: string;
  x264Preset?: string;
  masterPlaylistName?: string;
}

export function buildFfmpegPlan(input: BuildPlanInput): FfmpegPlan {
  const env = loadWorkerEnv();
  const hlsSeconds = input.hlsSeconds ?? env.TRANSCODE_HLS_SECONDS;
  const keyframeSeconds = input.keyframeSeconds ?? env.TRANSCODE_KEYFRAME_SECONDS;
  const videoCodec = input.videoCodec ?? env.TRANSCODE_VIDEO_CODEC;
  const audioCodec = input.audioCodec ?? env.TRANSCODE_AUDIO_CODEC;
  const preset = input.x264Preset ?? env.TRANSCODE_X264_PRESET;

  if (input.rungs.length === 0) throw new Error('No rungs to encode');
  if (hlsSeconds !== keyframeSeconds) {
    throw new Error(
      `TRANSCODE_HLS_SECONDS (${hlsSeconds}) must equal TRANSCODE_KEYFRAME_SECONDS (${keyframeSeconds})`,
    );
  }

  const args: string[] = ['-y', '-i', input.inputPath];

  // ── filter_complex: split the decoded video into N branches ──
  const labels = input.rungs.map((r) => r.label);
  const filterParts: string[] = [];
  input.rungs.forEach((rung, i) => {
    filterParts.push(
      `[v${i}]scale=w=${rung.width}:h=${rung.height}:force_original_aspect_ratio=decrease,` +
        `pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1[v${i}out]`,
    );
  });
  args.push('-filter_complex', filterParts.join(';'));

  // ── per-rung mapping + encoders ──
  input.rungs.forEach((rung, i) => {
    args.push(
      '-map', `[v${i}out]`,
      ...(input.source.hasAudio ? ['-map', '0:a:0'] : ['-an']),
      `-c:v:${i}`, videoCodec,
      `-b:v:${i}`, `${rung.videoBitrateKbps}k`,
      `-maxrate:v:${i}`, `${Math.round(rung.videoBitrateKbps * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(rung.videoBitrateKbps * 1.5)}k`,
      `-preset:${i}`, preset,
      '-profile:v:' + i, rung.height >= 1080 ? 'high' : 'main',
    );
    if (input.source.hasAudio) {
      args.push(
        `-c:a:${i}`, audioCodec,
        `-b:a:${i}`, `${rung.audioBitrateKbps}k`,
        '-ac', '2',
        '-ar', '48000',
      );
    }
  });

  // ── unified GOP / keyframe alignment across ALL rungs ──
  args.push(
    '-force_key_frames', `expr:gte(t,n_forced*${keyframeSeconds})`,
    '-g', String(Math.round(keyframeSeconds * (input.source.fps > 0 ? input.source.fps : 30))),
    '-keyint_min', String(Math.round(keyframeSeconds * (input.source.fps > 0 ? input.source.fps : 30))),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
  );

  // ── HLS muxing ──
  args.push(
    '-f', 'hls',
    '-hls_time', String(hlsSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments+append_list',
    '-hls_segment_filename', `${input.outputDir}/renditions/%v/seg_%05d.ts`,
    '-master_pl_name', input.masterPlaylistName ?? 'master.m3u8',
    '-var_stream_map',
    buildVarStreamMap(input.rungs, input.source.hasAudio),
    input.outputDir + '/%v.m3u8',
  );

  return { args, outputDir: input.outputDir, rungLabels: labels };
}

/**
 * var_stream_map tells the HLS muxer which streams form which rendition.
 * "v:0,a:0,name:240p v:1,a:1,name:480p ..."
 */
export function buildVarStreamMap(rungs: LadderRung[], hasAudio: boolean): string {
  return rungs
    .map((rung, i) => {
      const audioPart = hasAudio ? `,a:${i}` : '';
      return `v:${i}${audioPart},name:${rung.label}`;
    })
    .join(' ');
}

/**
 * Thumbnail-sprite command:
 *   one frame every SPRITE_FRAME_INTERVAL_SECONDS, scaled to tile size, tiled
 *   into a grid, plus the VTT index written by playlist.ts.
 */
export function buildSpriteArgs(input: {
  inputPath: string;
  outputDir: string;
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
  durationSeconds: number;
  tilePixelWidth?: number;
  tilePixelHeight?: number;
}): string[] {
  const tileW = input.tilePixelWidth ?? 160;
  const tileH = input.tilePixelHeight ?? 90;
  const totalSlots = input.tileWidth * input.tileHeight;
  const frames = Math.max(
    1,
    Math.min(totalSlots, Math.ceil(input.durationSeconds / input.intervalSeconds)),
  );
  const fps = 1 / input.intervalSeconds;
  // select=not(mod(n\,{N})) keeps one frame per interval.
  return [
    '-y',
    '-i', input.inputPath,
    '-vf',
    `fps=${fps},scale=${tileW}:${tileH},tile=${input.tileWidth}x${input.tileHeight}:padding=2:color=black`,
    '-frames:v', String(Math.max(1, Math.ceil(frames / (input.tileWidth * input.tileHeight)))),
    '-q:v', '3',
    `${input.outputDir}/sprite.jpg`,
  ];
}

/**
 * Subtitle extraction: embedded text subtitle streams → WebVTT files.
 */
export function buildSubtitleArgs(input: {
  inputPath: string;
  outputDir: string;
  streams: { index: number; language: string; codec: string; title: string | null }[];
}): string[][] {
  const commands: string[][] = [];
  for (const stream of input.streams) {
    // Text-based codecs convert directly; image-based (hdmv_pgs) are skipped
    // because VTT cannot represent them (documented in ARCHITECTURE.md).
    const textCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
    if (!textCodecs.includes(stream.codec)) continue;
    commands.push([
      '-y',
      '-i', input.inputPath,
      '-map', `0:${stream.index}`,
      '-c:s', 'webvtt',
      `${input.outputDir}/subtitles/${stream.language}.vtt`,
    ]);
  }
  return commands;
}
