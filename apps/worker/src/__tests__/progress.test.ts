import { describe, it, expect } from '@jest/globals';
import { parseFfmpegProgress } from '../transcode/progress';

describe('parseFfmpegProgress', () => {
  it('parses a standard progress line', () => {
    const line = 'frame=  120 fps= 60 q=28.0 size=    2048kB time=00:00:04.00 bitrate=4194.3kbits/s speed=2.01x';
    const p = parseFfmpegProgress(line);
    expect(p).not.toBeNull();
    expect(p!.timeSeconds).toBe(4.0);
    expect(p!.frame).toBe(120);
    expect(p!.fps).toBe(60);
    expect(p!.speed).toBe(2.01);
    expect(p!.sizeKb).toBe(2048);
  });

  it('parses HH:MM:SS.mmm time format', () => {
    const line = 'frame=  360 fps= 90 q=-1.0 size=    5120kB time=00:01:20.50 bitrate= 522.1kbits/s speed=1.83x';
    const p = parseFfmpegProgress(line);
    expect(p!.timeSeconds).toBeCloseTo(80.5, 2);
  });

  it('returns null for non-progress lines', () => {
    expect(parseFfmpegProgress('[hls @ 0x7f] Opening stream.ts for writing')).toBeNull();
    expect(parseFfmpegProgress('Press [q] to stop')).toBeNull();
  });

  it('handles N/A fields', () => {
    const line = 'frame=   12 fps=0.0 q=-1.0 size=N/A time=00:00:00.48 bitrate=N/A speed=1.24x';
    const p = parseFfmpegProgress(line);
    expect(p!.frame).toBe(12);
    expect(p!.timeSeconds).toBeCloseTo(0.48, 2);
    expect(p!.sizeKb).toBeUndefined();
    expect(p!.bitrateKbps).toBeUndefined();
  });

  it('computes percent against a known duration', () => {
    const line = 'time=00:00:30.00';
    const p = parseFfmpegProgress(line, 120);
    expect(p!.percent).toBe(25);
  });

  it('clamps percent above 100', () => {
    const p = parseFfmpegProgress('time=00:02:00.00', 100);
    expect(p!.percent).toBe(100);
  });
});
