import {
  buildMasterPlaylist,
  buildSpriteEntries,
  buildThumbnailVtt,
  formatTimestamp,
} from '../playlist';

describe('playlist', () => {
  const rung = (height: number, videoKbps: number) => ({
    height,
    width: Math.round((height * 16) / 9 / 2) * 2,
    videoBitrateKbps: videoKbps,
    audioBitrateKbps: 128,
    label: `${height}p`,
  });

  describe('buildMasterPlaylist', () => {
    it('writes BANDWIDTH as video+audio in bits per second', () => {
      const playlist = buildMasterPlaylist({
        rungs: [rung(720, 2500)],
        renditionUris: ['renditions/720p/index.m3u8'],
      });
      expect(playlist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2628000');
      expect(playlist).toContain('RESOLUTION=1280x720');
    });

    it('lists every rung in order', () => {
      const playlist = buildMasterPlaylist({
        rungs: [rung(240, 400), rung(480, 1000)],
        renditionUris: ['renditions/240p/index.m3u8', 'renditions/480p/index.m3u8'],
      });
      const lines = playlist.trim().split('\n');
      expect(lines[0]).toBe('#EXTM3U');
      expect(lines[1]).toBe('#EXT-X-VERSION:3');
      expect(playlist).toContain('renditions/240p/index.m3u8');
      expect(playlist).toContain('renditions/480p/index.m3u8');
    });

    it('declares the audio group when audio is present', () => {
      const playlist = buildMasterPlaylist({
        rungs: [rung(480, 1000)],
        renditionUris: ['renditions/480p/index.m3u8'],
      });
      expect(playlist).toContain('#EXT-X-MEDIA:TYPE=AUDIO');
      expect(playlist).toContain(',AUDIO="audio"');
    });

    it('omits the audio group when audio is absent', () => {
      const silentRung = { ...rung(480, 1000), audioBitrateKbps: 0 };
      const playlist = buildMasterPlaylist({
        rungs: [silentRung],
        renditionUris: ['renditions/480p/index.m3u8'],
      });
      expect(playlist).not.toContain('#EXT-X-MEDIA:TYPE=AUDIO');
      expect(playlist).not.toContain('AUDIO="audio"');
    });

    it('throws when rungs and URIs mismatch', () => {
      expect(() =>
        buildMasterPlaylist({ rungs: [rung(240, 400)], renditionUris: [] }),
      ).toThrow('same length');
    });

    it('ends with a newline', () => {
      const playlist = buildMasterPlaylist({
        rungs: [rung(240, 400)],
        renditionUris: ['a.m3u8'],
      });
      expect(playlist.endsWith('\n')).toBe(true);
    });
  });

  describe('formatTimestamp', () => {
    it('formats hours/minutes/seconds/millis', () => {
      expect(formatTimestamp(3661.5)).toBe('01:01:01.500');
    });

    it('zero-pads', () => {
      expect(formatTimestamp(2.04)).toBe('00:00:02.040');
    });
  });

  describe('buildSpriteEntries', () => {
    it('creates one entry per interval', () => {
      const entries = buildSpriteEntries(100, 10, 100);
      expect(entries).toHaveLength(10);
      expect(entries[0]).toMatchObject({ index: 0, startSeconds: 0, endSeconds: 10 });
      expect(entries[9]).toMatchObject({ index: 9, startSeconds: 90, endSeconds: 100 });
    });

    it('caps entries at the sprite capacity', () => {
      const entries = buildSpriteEntries(10_000, 10, 50);
      expect(entries).toHaveLength(50);
    });

    it('always produces at least one entry', () => {
      const entries = buildSpriteEntries(0, 10, 100);
      expect(entries).toHaveLength(1);
    });

    it('clamps the final entry to the duration', () => {
      const entries = buildSpriteEntries(25, 10, 100);
      expect(entries[entries.length - 1]!.endSeconds).toBe(25);
    });
  });

  describe('buildThumbnailVtt', () => {
    it('writes xywh coordinates for each tile', () => {
      const vtt = buildThumbnailVtt(
        [
          { index: 0, startSeconds: 0, endSeconds: 10 },
          { index: 1, startSeconds: 10, endSeconds: 20 },
          { index: 12, startSeconds: 120, endSeconds: 130 },
        ],
        { tileWidth: 10, tilePixelWidth: 160, tilePixelHeight: 90, spriteUri: 'sprite.jpg' },
      );
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(vtt).toContain('00:00:00.000 --> 00:00:10.000');
      expect(vtt).toContain('sprite.jpg#xywh=0,0,160,90');
      expect(vtt).toContain('sprite.jpg#xywh=160,0,160,90');
      // index 12 → row 1, col 2
      expect(vtt).toContain('sprite.jpg#xywh=320,90,160,90');
    });
  });
});
