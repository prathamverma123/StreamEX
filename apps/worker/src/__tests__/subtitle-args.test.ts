import { describe, it, expect } from '@jest/globals';
import { buildSubtitleArgs } from '../ffmpeg';

describe('buildSubtitleArgs', () => {
  it('emits one ffmpeg command per text-based subtitle stream', () => {
    const commands = buildSubtitleArgs({
      inputPath: '/work/source.mkv',
      outputDir: '/work/hls',
      streams: [
        { index: 3, language: 'eng', codec: 'subrip', title: 'English', isDefault: true },
        { index: 4, language: 'deu', codec: 'subrip', title: 'Deutsch', isDefault: false },
      ],
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual([
      '-y',
      '-i', '/work/source.mkv',
      '-map', '0:3',
      '-c:s', 'webvtt',
      '/work/hls/subtitles/eng.vtt',
    ]);
    expect(commands[1]).toContain('0:4');
    expect(commands[1]!.at(-1)).toBe('/work/hls/subtitles/deu.vtt');
  });

  it('skips image-based codecs that WebVTT cannot represent', () => {
    const commands = buildSubtitleArgs({
      inputPath: '/work/source.mkv',
      outputDir: '/work/hls',
      streams: [
        { index: 5, language: 'eng', codec: 'hdmv_pgs_subtitle', title: 'PGS', isDefault: false },
        { index: 6, language: 'fra', codec: 'dvd_subtitle', title: 'VOBSub', isDefault: false },
      ],
    });
    expect(commands).toHaveLength(0);
  });

  it('converts every supported text codec', () => {
    const codecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
    const commands = buildSubtitleArgs({
      inputPath: '/src.mkv',
      outputDir: '/out',
      streams: codecs.map((codec, i) => ({
        index: i,
        language: `lang${i}`,
        codec,
        title: null,
        isDefault: false,
      })),
    });
    expect(commands).toHaveLength(codecs.length);
    for (const cmd of commands) {
      expect(cmd).toContain('-c:s');
      expect(cmd).toContain('webvtt');
    }
  });

  it('returns no commands when the source has no subtitle streams', () => {
    expect(
      buildSubtitleArgs({ inputPath: '/src.mp4', outputDir: '/out', streams: [] }),
    ).toEqual([]);
  });
});
