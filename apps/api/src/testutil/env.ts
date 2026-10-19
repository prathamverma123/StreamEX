/**
 * Jest setup file (jest.config.js setupFiles).
 *
 * Runs before every test file. Provides deterministic environment values for
 * every variable the env schema requires, so tests never depend on a
 * developer's local .env.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://streamex:streamex@localhost:5432/streamex_test?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

process.env.JWT_ACCESS_SECRET ??=
  'test-access-secret-0123456789-abcdefghij';
process.env.JWT_REFRESH_SECRET ??=
  'test-refresh-secret-0123456789-abcdefghij';
process.env.JWT_ACCESS_KID ??= 'test-access-kid';
process.env.JWT_REFRESH_KID ??= 'test-refresh-kid';
process.env.JWT_ACCESS_SECRET_PREVIOUS ??= '';
process.env.JWT_REFRESH_SECRET_PREVIOUS ??= '';
process.env.JWT_PREVIOUS_KID ??= '';
process.env.JWT_ACCESS_TTL ??= '15m';
process.env.JWT_REFRESH_TTL ??= '30d';

process.env.HLS_SIGNING_SECRET ??= 'test-hls-signing-secret-0123456789abcdef';
process.env.HLS_TOKEN_TTL_SECONDS ??= '3600';
process.env.HLS_SEGMENT_PREFIX ??= 'hls';

process.env.STORAGE_BACKEND ??= 'local';
process.env.STORAGE_LOCAL_ROOT ??= './storage-test';
process.env.S3_ENDPOINT ??= '';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_BUCKET ??= 'streamex-test';
process.env.S3_ACCESS_KEY_ID ??= '';
process.env.S3_SECRET_ACCESS_KEY ??= '';
process.env.S3_FORCE_PATH_STYLE ??= 'true';
process.env.S3_SIGNED_URL_TTL_SECONDS ??= '3600';
process.env.S3_USE_PRESIGNED_PLAYBACK ??= 'false';

process.env.UPLOAD_MAX_BYTES ??= '21474836480';
process.env.UPLOAD_CHUNK_SIZE ??= '8388608';
process.env.UPLOAD_TTL_SECONDS ??= '86400';

process.env.TRANSCODE_CONCURRENCY ??= '2';
process.env.TRANSCODE_MAX_ATTEMPTS ??= '3';

process.env.CDN_BASE_URL ??= 'http://localhost:8080';
process.env.API_URL ??= 'http://localhost:4000';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
process.env.CORS_ORIGINS ??= 'http://localhost:5173,http://localhost:3000';

process.env.RATE_LIMIT_WINDOW_SECONDS ??= '60';
process.env.RATE_LIMIT_AUTH_MAX ??= '5';
process.env.RATE_LIMIT_GLOBAL_MAX ??= '8';

process.env.SMTP_HOST ??= '';
process.env.SMTP_PORT ??= '1025';
process.env.SMTP_SECURE ??= 'false';
process.env.SMTP_USER ??= '';
process.env.SMTP_PASS ??= '';
process.env.SMTP_FROM ??= 'StreamEX <no-reply@streamex.dev>';
process.env.MAIL_TRANSPORT ??= 'console';

process.env.SOCKET_PATH ??= '/socket.io';
process.env.REALTIME_EVENT_CHANNEL ??= 'events:transcode';
process.env.REALTIME_PROGRESS_CHANNEL ??= 'events:progress';
process.env.QUEUE_NAME_TRANSCODE ??= 'transcode';
process.env.QUEUE_NAME_TRANSCODE_DLQ ??= 'transcode:dlq';
process.env.QUEUE_NAME_EMAIL ??= 'email';

process.env.SWAGGER_ENABLED ??= 'false';
process.env.SWAGGER_PATH ??= '/docs';

process.env.LOG_LEVEL ??= 'silent';
process.env.LOG_PRETTY ??= 'false';
