/**
 * Test utilities for the StreamEX API.
 *
 * - `makePrismaMock` — a Prisma client mock with typed, jest-mocked model
 *   delegates. Tests pass overrides to shape responses per call site.
 * - `makeStorageMock` — in-memory Storage implementation.
 * - `makeRedisMock` — ioredis mock with a working pub/sub + key store.
 * - fixture builders for titles/assets/profiles.
 * - `stubQueueProducer` — replaces the BullMQ producer with a spy.
 */

import { jest } from '@jest/globals';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { Storage } from '@streamex/storage';
import type Redis from 'ioredis';

// ───────────────────────────── Prisma mock ─────────────────────────────

type AnyDelegate = Record<string, jest.Mock>;

export interface PrismaMock {
  client: PrismaClient;
  models: Record<string, AnyDelegate>;
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

/**
 * Build a Prisma client mock covering every model the services touch.
 * Every delegate method returns `undefined` by default and is overridden
 * per-test via `mockResolvedValue` / `mockImplementation`.
 */
export function makePrismaMock(): PrismaMock {
  const models: Record<string, AnyDelegate> = {};
  const methods = [
    'findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany',
    'delete', 'deleteMany', 'upsert', 'count', 'aggregate',
  ];

  const modelNames = [
    'user', 'profile', 'session', 'passwordResetToken',
    'title', 'season', 'episode',
    'videoAsset', 'videoRendition', 'subtitleTrack',
    'uploadSession', 'watchProgress', 'watchlistEntry',
    'bulkIngestion', 'moderationItem',
  ];

  for (const name of modelNames) {
    const delegate: AnyDelegate = {};
    for (const method of methods) {
      delegate[method] = jest.fn().mockName(`prisma.${name}.${method}`);
    }
    models[name] = delegate;
  }

  const $queryRaw = jest.fn().mockName('prisma.$queryRaw');
  const $executeRaw = jest.fn().mockName('prisma.$executeRaw');
  const $transaction = jest
    .fn()
    .mockName('prisma.$transaction')
    // Default: run the array of operations through, returning their results.
    .mockImplementation(async (operations: unknown) => {
      if (Array.isArray(operations)) {
        const results: unknown[] = [];
        for (const op of operations) {
          results.push(await op);
        }
        return results;
      }
      if (typeof operations === 'function') return operations(client);
      return undefined;
    });
  const $disconnect = jest.fn().mockName('prisma.$disconnect');

  const client = {
    user: models.user,
    profile: models.profile,
    session: models.session,
    passwordResetToken: models.passwordResetToken,
    title: models.title,
    season: models.season,
    episode: models.episode,
    videoAsset: models.videoAsset,
    videoRendition: models.videoRendition,
    subtitleTrack: models.subtitleTrack,
    uploadSession: models.uploadSession,
    watchProgress: models.watchProgress,
    watchlistEntry: models.watchlistEntry,
    bulkIngestion: models.bulkIngestion,
    moderationItem: models.moderationItem,
    $queryRaw,
    $executeRaw,
    $transaction,
    $disconnect,
  } as unknown as PrismaClient;

  return { client, models, $queryRaw, $executeRaw, $transaction };
}

// ───────────────────────────── Storage mock ─────────────────────────────

export interface StorageMock extends Storage {
  objects: Map<string, Buffer>;
  puts: jest.Mock;
  getBuffer: jest.Mock;
  get: jest.Mock;
  stat: jest.Mock;
  exists: jest.Mock;
  delete: jest.Mock;
  deletePrefix: jest.Mock;
  signUrl: jest.Mock;
  putFile: jest.Mock;
  localPath: jest.Mock;
}

/** In-memory Storage — enough for the upload + HLS streaming tests. */
export function makeStorageMock(): StorageMock {
  const objects = new Map<string, Buffer>();
  const mock: StorageMock = {
    backend: 'local',
    objects,
    puts: jest.fn().mockName('storage.put'),
    getBuffer: jest.fn().mockName('storage.getBuffer'),
    get: jest.fn().mockName('storage.get'),
    stat: jest.fn().mockName('storage.stat'),
    exists: jest.fn().mockName('storage.exists'),
    delete: jest.fn().mockName('storage.delete'),
    deletePrefix: jest.fn().mockName('storage.deletePrefix'),
    signUrl: jest.fn().mockName('storage.signUrl'),
    putFile: jest.fn().mockName('storage.putFile'),
    localPath: jest.fn().mockName('storage.localPath'),
    async put(key, stream, _options) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      const buf = Buffer.concat(chunks);
      objects.set(key, buf);
      this.puts.mock.calls.push([key, stream, _options]);
      return { size: buf.length, modifiedAt: new Date() };
    },
    async getBuffer(key) {
      const buf = objects.get(key);
      if (!buf) throw new (await import('@streamex/storage')).StorageNotFoundError(key);
      return buf;
    },
    async get(key) {
      const buf = objects.get(key);
      if (!buf) throw new (await import('@streamex/storage')).StorageNotFoundError(key);
      const { Readable } = await import('node:stream');
      return { stream: Readable.from(buf), length: buf.length };
    },
    async stat(key) {
      const buf = objects.get(key);
      if (!buf) throw new (await import('@streamex/storage')).StorageNotFoundError(key);
      return { size: buf.length, modifiedAt: new Date() };
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      let n = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          n += 1;
        }
      }
      return n;
    },
    async signUrl(key, options) {
      return `http://cdn.test/signed/${key}?exp=${options.expiresIn}`;
    },
    async putFile(key, localPath, _options) {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(localPath);
      objects.set(key, buf);
      return { size: buf.length, modifiedAt: new Date() };
    },
    localPath(key) {
      return `/tmp/streamex-test/${key}`;
    },
  };
  return mock;
}

// ───────────────────────────── Redis mock ─────────────────────────────

export interface RedisMock extends Redis {
  store: Map<string, string>;
  publish: jest.Mock;
  subscribe: jest.Mock;
  quit: jest.Mock;
}

/** Minimal ioredis mock: pub/sub with local channel listeners + key store. */
export function makeRedisMock(): RedisMock {
  const channels = new Map<string, ((message: string) => void)[]>();
  const store = new Map<string, string>();
  const mock = {
    store,
    publish: jest.fn().mockName('redis.publish').mockImplementation(async (channel: string, message: string) => {
      const subs = channels.get(channel) ?? [];
      for (const fn of subs) fn(message);
      return subs.length;
    }),
    subscribe: jest.fn().mockName('redis.subscribe').mockImplementation(async (channel: string) => {
      channels.set(channel, [...(channels.get(channel) ?? []), (message: string) => mock.emit('message', channel, message)]);
      return 'OK';
    }),
    psubscribe: jest.fn().mockName('redis.psubscribe').mockResolvedValue('OK'),
    quit: jest.fn().mockName('redis.quit').mockResolvedValue('OK'),
    disconnect: jest.fn().mockName('redis.disconnect'),
    on: jest.fn().mockName('redis.on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (!mock._listeners.has(event)) mock._listeners.set(event, []);
      mock._listeners.get(event)!.push(listener);
      return mock;
    }),
    _listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
    emit(event: string, ...args: unknown[]) {
      for (const listener of mock._listeners.get(event) ?? []) listener(...args);
    },
    get: jest.fn().mockName('redis.get').mockImplementation(async (key: string) => store.get(key) ?? null),
    set: jest.fn().mockName('redis.set').mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    incr: jest.fn().mockName('redis.incr').mockImplementation(async (key: string) => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(n));
      return n;
    }),
    del: jest.fn().mockName('redis.del').mockImplementation(async (...keys: string[]) => {
      let n = 0;
      for (const key of keys) {
        if (store.delete(key)) n += 1;
      }
      return n;
    }),
  };
  return mock as unknown as RedisMock;
}

// ───────────────────────────── Queue producer stub ─────────────────────

import * as producer from '../queues/producer.js';

/**
 * Replace the BullMQ queue behind enqueueTranscode with a spy.
 * enqueueTranscode calls getTranscodeQueue().add — stub the queue getter.
 * Returns restore() to put the real queue back.
 */
export function stubQueueProducer(): {
  enqueueTranscode: jest.Mock;
  restore: () => void;
} {
  const spy = jest.fn().mockResolvedValue('job-1');
  const original = producer.getTranscodeQueue;
  (producer as unknown as { getTranscodeQueue: () => unknown }).getTranscodeQueue = () =>
    ({
      add: spy,
      close: async () => undefined,
    }) as unknown;
  const restore = () => {
    (producer as unknown as { getTranscodeQueue: () => unknown }).getTranscodeQueue = original;
  };
  return { enqueueTranscode: spy, restore };
}

// ───────────────────────────── Fixtures ─────────────────────────────

export const UUIDS = {
  user: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  profile: '33333333-3333-4333-8333-333333333333',
  kidsProfile: '44444444-4444-4444-8444-444444444444',
  titleA: '55555555-5555-4555-8555-555555555555',
  titleB: '66666666-6666-4666-8666-666666666666',
  episode: '77777777-7777-4777-8777-777777777777',
  season: '88888888-8888-4888-8888-888888888888',
  asset: '99999999-9999-4999-8999-999999999999',
  uploadSession: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  session: 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  resetToken: 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1',
  watchProgress: 'ddddddd1-dddd-4ddd-8ddd-dddddddddd1',
  watchlistEntry: 'eeeeeee1-eeee-4eee-8eee-eeeeeeeeeee1',
  moderationItem: 'fffffff1-ffff-4fff-8fff-fffffffffff1',
  rendition240: '1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a',
  rendition480: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a',
  rendition720: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a',
  rendition1080: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a',
} as const;

export function fixtureUser(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.user,
    email: 'viewer@streamex.dev',
    passwordHash: '$2a$12$K3tVv0Pn2QO1TQc9w0N1hOZ1hL9pV3dWJZ8yT4uI3oO9aBcDeFgHi',
    role: 'USER',
    emailVerified: null,
    isSuspended: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function fixtureAdmin(overrides: Record<string, unknown> = {}) {
  return fixtureUser({
    id: UUIDS.admin,
    email: 'admin@streamex.dev',
    role: 'ADMIN',
    ...overrides,
  });
}

export function fixtureProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.profile,
    userId: UUIDS.user,
    name: 'Main',
    avatarUrl: null,
    isKids: false,
    language: 'en',
    maturity: 100,
    autoplayNext: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function fixtureKidsProfile(overrides: Record<string, unknown> = {}) {
  return fixtureProfile({
    id: UUIDS.kidsProfile,
    name: 'Kids',
    isKids: true,
    maturity: 10,
    ...overrides,
  });
}

export function fixtureTitle(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.titleA,
    slug: 'aurora-drift',
    type: 'MOVIE',
    name: 'Aurora Drift',
    synopsis: 'A lone cartographer maps a signal from deep space.',
    releaseYear: 2024,
    rating: 'PG-13',
    maturityRating: 'PG-13',
    runtimeMinutes: 118,
    posterUrl: 'https://cdn.test/aurora-poster.jpg',
    backdropUrl: 'https://cdn.test/aurora-backdrop.jpg',
    trailerUrl: null,
    heroLandscapeUrl: null,
    isFeatured: true,
    isOriginal: true,
    originalLanguage: 'en',
    genres: ['Sci-Fi', 'Drama'],
    tags: ['space', 'isolation'],
    cast: ['R. Ellery'],
    directors: ['J. Lindqvist'],
    status: 'PUBLISHED',
    viewCount: BigInt(158_000),
    likeCount: BigInt(3_000),
    moderationStatus: 'APPROVED',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function fixtureAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.asset,
    episodeId: null,
    titleId: UUIDS.titleA,
    status: 'READY',
    sourceKey: `sources/${UUIDS.asset}/source.mp4`,
    sourceEtag: 'd41d8cd98f00b204e9800998ecf8427e',
    sourceSizeBytes: BigInt(4_200_000_000),
    sourceMime: 'video/mp4',
    container: 'mp4',
    durationSeconds: 6_840,
    sourceWidth: 1920,
    sourceHeight: 1080,
    thumbnailSpriteKey: `assets/${UUIDS.asset}/hls/sprite.jpg`,
    thumbnailVttKey: `assets/${UUIDS.asset}/hls/thumbs.vtt`,
    masterPlaylistKey: `assets/${UUIDS.asset}/hls/master.m3u8`,
    processingPercent: 100,
    errorMessage: null,
    attempts: 0,
    lastErrorCode: null,
    uploadedById: UUIDS.admin,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    readyAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function fixtureRenditions(assetId = UUIDS.asset) {
  const specs = [
    { id: UUIDS.rendition240, label: '240p', width: 426, height: 240, kbps: 400 },
    { id: UUIDS.rendition480, label: '480p', width: 854, height: 480, kbps: 1000 },
    { id: UUIDS.rendition720, label: '720p', width: 1280, height: 720, kbps: 2500 },
    { id: UUIDS.rendition1080, label: '1080p', width: 1920, height: 1080, kbps: 5000 },
  ];
  return specs.map((s) => ({
    id: s.id,
    assetId,
    label: s.label,
    width: s.width,
    height: s.height,
    videoBitrateKbps: s.kbps,
    audioBitrateKbps: 128,
    codec: 'h264',
    playlistKey: `assets/${assetId}/hls/renditions/${s.label}/index.m3u8`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }));
}

export function fixtureWatchProgress(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.watchProgress,
    profileId: UUIDS.profile,
    titleId: UUIDS.titleA,
    episodeId: null,
    positionSeconds: 900,
    durationSeconds: 6_840,
    percentWatched: 13.2,
    completed: false,
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

export function fixtureSession(overrides: Record<string, unknown> = {}) {
  return {
    id: UUIDS.session,
    userId: UUIDS.user,
    tokenHash: 'pending',
    familyId: 'fam-1',
    userAgent: 'jest',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Valid password that passes the schema's complexity rules. */
export const TEST_PASSWORD = 'Sup3rSecret!pass';
