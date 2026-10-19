import { buildLadder, parseLadderSpec, totalBitrateKbps, widthForHeight } from '../ladder';

describe('ladder', () => {
  beforeEach(() => {
    process.env.TRANSCODE_LADDER = '240:400,480:1000,720:2500,1080:5000,2160:15000';
    process.env.TRANSCODE_AUDIO_BITRATE_KBPS = '128';
    process.env.TRANSCODE_ENABLE_4K = 'false';
  });

  describe('parseLadderSpec', () => {
    it('parses the default spec into sorted rungs', () => {
      const rungs = parseLadderSpec('240:400,480:1000,720:2500,1080:5000,2160:15000');
      expect(rungs).toHaveLength(5);
      expect(rungs[0]).toEqual({ height: 240, videoBitrateKbps: 400 });
      expect(rungs[4]).toEqual({ height: 2160, videoBitrateKbps: 15000 });
    });

    it('sorts unsorted input', () => {
      const rungs = parseLadderSpec('1080:5000,240:400');
      expect(rungs.map((r) => r.height)).toEqual([240, 1080]);
    });

    it('throws on an invalid entry', () => {
      expect(() => parseLadderSpec('240:abc')).toThrow('Invalid ladder entry');
      expect(() => parseLadderSpec('-5:400')).toThrow('Invalid ladder entry');
    });

    it('tolerates whitespace and trailing commas', () => {
      const rungs = parseLadderSpec(' 240:400 , 480:1000, ');
      expect(rungs).toHaveLength(2);
    });
  });

  describe('widthForHeight', () => {
    it('keeps aspect ratio for 16:9 sources', () => {
      expect(widthForHeight(1920, 1080, 720)).toBe(1280);
    });

    it('produces even dimensions for odd ratios', () => {
      const w = widthForHeight(854, 480, 240);
      expect(w % 2).toBe(0);
      expect(w).toBe(428);
    });

    it('falls back to 16:9 for zero-size sources', () => {
      expect(widthForHeight(0, 0, 360)).toBe(640);
    });
  });

  describe('buildLadder', () => {
    it('builds the full ladder for a 4K source', () => {
      const rungs = buildLadder({
        sourceHeight: 2160,
        sourceWidth: 3840,
        sourceBitrateKbps: 45000,
        enable4k: true,
      });
      expect(rungs.map((r) => r.label)).toEqual(['240p', '480p', '720p', '1080p', '2160p']);
    });

    it('skips 4K when TRANSCODE_ENABLE_4K is false', () => {
      const rungs = buildLadder({
        sourceHeight: 2160,
        sourceWidth: 3840,
        sourceBitrateKbps: 45000,
        enable4k: false,
      });
      expect(rungs.map((r) => r.label)).toEqual(['240p', '480p', '720p', '1080p']);
    });

    it('skips rungs above the source resolution (1080p source)', () => {
      const rungs = buildLadder({
        sourceHeight: 1080,
        sourceWidth: 1920,
        sourceBitrateKbps: 9000,
      });
      expect(rungs.map((r) => r.label)).toEqual(['240p', '480p', '720p', '1080p']);
      expect(rungs.every((r) => r.height <= 1080)).toBe(true);
    });

    it('skips 4K even for a 4K source when not enabled', () => {
      const rungs = buildLadder({
        sourceHeight: 2160,
        sourceWidth: 3840,
        sourceBitrateKbps: 20000,
        enable4k: false,
      });
      expect(rungs.map((r) => r.label)).not.toContain('2160p');
    });

    it('keeps at least the smallest rung for a tiny source', () => {
      const rungs = buildLadder({
        sourceHeight: 144,
        sourceWidth: 256,
        sourceBitrateKbps: 300,
      });
      expect(rungs).toHaveLength(1);
      expect(rungs[0]!.height).toBe(144);
    });

    it('clamps the fallback rung to a 2px minimum', () => {
      const rungs = buildLadder({
        sourceHeight: 1,
        sourceWidth: 2,
        sourceBitrateKbps: 100,
      });
      expect(rungs[0]!.height).toBeGreaterThanOrEqual(2);
    });

    it('skips the top rung when it exceeds 1.5x the source bitrate', () => {
      // A low-bitrate 1080p screencast: 15000kbps 4K would be skipped by the
      // enable4k flag anyway; assert the bitrate clamp on the 1080p rung.
      const rungs = buildLadder({
        sourceHeight: 2160,
        sourceWidth: 3840,
        sourceBitrateKbps: 6000,
        enable4k: true,
      });
      // 2160p rung (15000kbps) exceeds 6000 * 1.5 → skipped.
      expect(rungs.map((r) => r.label)).not.toContain('2160p');
    });

    it('attaches the configured audio bitrate to every rung', () => {
      const rungs = buildLadder({
        sourceHeight: 720,
        sourceWidth: 1280,
        sourceBitrateKbps: 4000,
        audioBitrateKbps: 96,
      });
      expect(rungs.every((r) => r.audioBitrateKbps === 96)).toBe(true);
    });
  });

  describe('totalBitrateKbps', () => {
    it('sums video and audio', () => {
      expect(
        totalBitrateKbps({
          height: 720,
          width: 1280,
          videoBitrateKbps: 2500,
          audioBitrateKbps: 128,
          label: '720p',
        }),
      ).toBe(2628);
    });
  });
});
