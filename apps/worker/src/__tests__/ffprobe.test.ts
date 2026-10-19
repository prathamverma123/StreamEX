import { parseFfprobe, parseFps, ffprobeArgs } from '../ffprobe';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ffprobe parser tests — driven by a RECORDED ffprobe fixture so no binary is
 * required on the CI host.
 */

const fixtureDir = path.join(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), 'utf8');
}

describe('ffprobe', () => {
  it('ffprobeArgs requests json with format and streams', () => {
    const args = ffprobeArgs('/tmp/source.mp4');
    expect(args).toContain('-print_format');
    expect(args).toContain('json');
    expect(args).toContain('-show_format');
    expect(args).toContain('-show_streams');
    expect(args[args.length - 1]).toBe('/tmp/source.mp4');
  });

  describe('parseFps', () => {
    it('parses NTSC rates', () => {
      expect(parseFps('30000/1001')).toBe(29.97);
    });
    it('parses plain rates', () => {
      expect(parseFps('25/1')).toBe(25);
    });
    it('returns 0 for garbage', () => {
      expect(parseFps('nonsense')).toBe(0);
      expect(parseFps('10/0')).toBe(0);
    });
  });

  describe('parseFfprobe with a 1080p fixture', () => {
    let info: ReturnType<typeof parseFfprobe>;

    beforeEach(() => {
      info = parseFfprobe(loadFixture('ffprobe-1080p-subs.json'));
    });

    it('extracts dimensions and duration', () => {
      expect(info.width).toBe(1920);
      expect(info.height).toBe(1080);
      expect(info.durationSeconds).toBeCloseTo(5420.5, 1);
    });

    it('extracts codecs and fps', () => {
      expect(info.videoCodec).toBe('h264');
      expect(info.audioCodec).toBe('aac');
      expect(info.fps).toBeCloseTo(23.976, 2);
    });

    it('extracts container and bitrate', () => {
      expect(info.container).toBe('matroska');
      expect(info.bitrateBps).toBe(8697000);
    });

    it('detects embedded subtitle streams with language tags', () => {
      expect(info.subtitleStreams).toHaveLength(2);
      expect(info.subtitleStreams[0]).toMatchObject({
        index: 3,
        codec: 'subrip',
        language: 'eng',
        title: 'English',
        isDefault: true,
      });
      expect(info.subtitleStreams[1]).toMatchObject({
        index: 4,
        codec: 'subrip',
        language: 'deu',
      });
    });

    it('reports hasAudio', () => {
      expect(info.hasAudio).toBe(true);
    });
  });

  describe('parseFfprobe with an audio-less fixture', () => {
    it('reports hasAudio false and no audio codec', () => {
      const info = parseFfprobe(loadFixture('ffprobe-no-audio.json'));
      expect(info.hasAudio).toBe(false);
      expect(info.audioCodec).toBeNull();
      expect(info.subtitleStreams).toHaveLength(0);
    });
  });
});
