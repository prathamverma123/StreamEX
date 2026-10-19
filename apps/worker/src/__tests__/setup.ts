/**
 * Jest setup — seeds the worker env before any module loads.
 *
 * The pure builders (ladder, ffmpeg, playlist) call loadWorkerEnv() for their
 * defaults, and the env schema requires DATABASE_URL even though these tests
 * never touch a database. A fixed seed keeps the builders deterministic and
 * hermetic.
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://streamex:streamex@localhost:5432/streamex_test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_BACKEND = 'local';
process.env.STORAGE_LOCAL_ROOT = './storage';
process.env.CDN_BASE_URL = 'http://localhost:8080';
process.env.TRANSCODE_TMP_DIR = './work';
process.env.TRANSCODE_LADDER = '240:400,480:1000,720:2500,1080:5000,2160:15000';
process.env.TRANSCODE_AUDIO_BITRATE_KBPS = '128';
process.env.TRANSCODE_HLS_SECONDS = '2';
process.env.TRANSCODE_KEYFRAME_SECONDS = '2';
process.env.TRANSCODE_CONCURRENCY = '2';
process.env.TRANSCODE_MAX_ATTEMPTS = '3';
process.env.SPRITE_FRAME_INTERVAL_SECONDS = '10';
process.env.SPRITE_TILE_WIDTH = '10';
process.env.SPRITE_TILE_HEIGHT = '10';
process.env.LOG_LEVEL = 'fatal';
