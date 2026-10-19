import { getPrisma } from '../../lib/prisma.js';
import type { HeartbeatInput } from './progress.schemas.js';

/**
 * Watch-progress service.
 *
 * Heartbeat debounce: the client fires a heartbeat every ~5s, but we only
 * persist when the position has advanced ≥15s since the last stored position,
 * or ≥30s have passed since the last write. This keeps write volume low while
 * guaranteeing resume positions stay within one window of reality.
 */

export const MIN_POSITION_DELTA = 15; // seconds of new playback
export const MIN_TIME_DELTA = 30; // seconds since last persistence
export const COMPLETION_THRESHOLD = 0.95; // ≥95% watched → completed

export interface HeartbeatResult {
  persisted: boolean;
  reason: 'first-write' | 'position-delta' | 'time-delta' | 'skipped';
  progress: {
    id: string;
    positionSeconds: number;
    durationSeconds: number;
    percentWatched: number;
    completed: boolean;
  };
}

export function shouldPersist(
  existing: { positionSeconds: number; updatedAt: Date } | null,
  incoming: { positionSeconds: number },
  now = new Date(),
): { persist: boolean; reason: HeartbeatResult['reason'] } {
  if (!existing) return { persist: true, reason: 'first-write' };
  const positionDelta = incoming.positionSeconds - existing.positionSeconds;
  const timeDelta = (now.getTime() - existing.updatedAt.getTime()) / 1000;
  if (positionDelta >= MIN_POSITION_DELTA) return { persist: true, reason: 'position-delta' };
  if (positionDelta < 0) return { persist: false, reason: 'skipped' };
  if (timeDelta >= MIN_TIME_DELTA) return { persist: true, reason: 'time-delta' };
  return { persist: false, reason: 'skipped' };
}

export function percentWatched(position: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(1, position / duration)) * 100;
}

export async function recordHeartbeat(
  profileId: string,
  input: HeartbeatInput,
  now = new Date(),
): Promise<HeartbeatResult> {
  const prisma = getPrisma();
  const existing = await prisma.watchProgress.findFirst({
    where: {
      profileId,
      titleId: input.titleId,
      ...(input.episodeId ? { episodeId: input.episodeId } : { episodeId: null }),
    },
  });
  const decision = shouldPersist(
    existing ? { positionSeconds: existing.positionSeconds, updatedAt: existing.updatedAt } : null,
    { positionSeconds: input.positionSeconds },
    now,
  );
  const pct = percentWatched(input.positionSeconds, input.durationSeconds);
  const completed = pct >= COMPLETION_THRESHOLD * 100;
  if (!decision.persist) {
    return {
      persisted: false,
      reason: decision.reason,
      progress: existing
        ? {
            id: existing.id,
            positionSeconds: existing.positionSeconds,
            durationSeconds: existing.durationSeconds,
            percentWatched: existing.percentWatched,
            completed: existing.completed,
          }
        : {
            id: 'none',
            positionSeconds: input.positionSeconds,
            durationSeconds: input.durationSeconds,
            percentWatched: pct,
            completed,
          },
    };
  }
  // NOTE: the compound unique cannot target rows where episodeId IS NULL
  // (Prisma's compound-unique input requires non-null values), so the upsert
  // is done as update-by-id / create. enhance.ts adds a partial unique index
  // (profile_id, title_id) WHERE episode_id IS NULL to keep the invariant.
  const row = existing
    ? await prisma.watchProgress.update({
        where: { id: existing.id },
        data: {
          positionSeconds: Math.floor(input.positionSeconds),
          durationSeconds: input.durationSeconds,
          percentWatched: pct,
          completed: completed || existing.completed === true,
        },
      })
    : await prisma.watchProgress.create({
        data: {
          profileId,
          titleId: input.titleId,
          episodeId: input.episodeId ?? null,
          positionSeconds: Math.floor(input.positionSeconds),
          durationSeconds: input.durationSeconds,
          percentWatched: pct,
          completed,
        },
      });
  return {
    persisted: true,
    reason: decision.reason,
    progress: {
      id: row.id,
      positionSeconds: row.positionSeconds,
      durationSeconds: row.durationSeconds,
      percentWatched: row.percentWatched,
      completed: row.completed,
    },
  };
}

export interface ContinueWatchingItem {
  id: string;
  titleId: string;
  episodeId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  percentWatched: number;
  completed: boolean;
  updatedAt: Date;
  resumePosition: number;
  title: {
    id: string;
    name: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    type: string;
    rating: string;
  };
  episodeMeta: { number: number; name: string; seasonNumber: number } | null;
}

export async function continueWatching(
  profileId: string,
  limit: number,
): Promise<ContinueWatchingItem[]> {
  const prisma = getPrisma();
  const rows = await prisma.watchProgress.findMany({
    where: { profileId, completed: false },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      title: {
        select: { id: true, name: true, posterUrl: true, backdropUrl: true, type: true, rating: true },
      },
      episode: { select: { number: true, name: true, season: { select: { number: true } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    titleId: row.titleId,
    episodeId: row.episodeId,
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    percentWatched: row.percentWatched,
    completed: row.completed,
    updatedAt: row.updatedAt,
    resumePosition: resumePosition(row.positionSeconds, row.durationSeconds),
    title: row.title,
    episodeMeta: row.episode
      ? {
          number: row.episode.number,
          name: row.episode.name,
          seasonNumber: row.episode.season.number,
        }
      : null,
  }));
}

/** Resume-position calculation — rewind 5s so the user re-enters context. */
export function resumePosition(position: number, duration: number): number {
  if (position <= 0) return 0;
  const back = Math.max(0, position - 5);
  if (duration > 0 && back >= duration * COMPLETION_THRESHOLD) {
    return 0; // essentially finished → start over
  }
  return Math.floor(back);
}

/** Single-title progress lookup (resume banner). */
export async function progressForTitle(
  profileId: string,
  titleId: string,
  episodeId?: string,
) {
  const prisma = getPrisma();
  const row = await prisma.watchProgress.findFirst({
    where: { profileId, titleId, episodeId: episodeId ?? null },
  });
  if (!row) return null;
  return {
    ...row,
    resumePosition: resumePosition(row.positionSeconds, row.durationSeconds),
  };
}
