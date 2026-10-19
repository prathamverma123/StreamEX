import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { heartbeatSchema, continueWatchingQuerySchema } from './progress.schemas.js';
import * as service from './progress.service.js';
import { publishProgressSync } from '../../realtime/publish.js';

export const heartbeat = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (!req.profileId) throw new UnauthorizedError('X-Profile-Id header is required');
  const input = heartbeatSchema.parse(req.body);
  const result = await service.recordHeartbeat(req.profileId, input);
  if (result.persisted) {
    // Fan out to the profile's other devices.
    publishProgressSync(req.profileId, {
      titleId: input.titleId,
      episodeId: input.episodeId ?? null,
      positionSeconds: result.progress.positionSeconds,
      durationSeconds: result.progress.durationSeconds,
      percentWatched: result.progress.percentWatched,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
  }
  res.json(result);
});

export const continueWatching = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (!req.profileId) throw new UnauthorizedError('X-Profile-Id header is required');
  const { limit } = continueWatchingQuerySchema.parse(req.query);
  const items = await service.continueWatching(req.profileId, limit);
  res.json({ items });
});

export const getByTitle = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (!req.profileId) throw new UnauthorizedError('X-Profile-Id header is required');
  const item = await service.progressForTitle(
    req.profileId,
    String(req.params.titleId),
    req.query.episodeId ? String(req.query.episodeId) : undefined,
  );
  res.json({ progress: item });
});
