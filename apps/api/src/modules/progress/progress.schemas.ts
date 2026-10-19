import { z } from 'zod';

export const heartbeatSchema = z.object({
  titleId: z.string().uuid(),
  episodeId: z.string().uuid().optional(),
  positionSeconds: z.number().min(0).max(604800),
  durationSeconds: z.number().min(0).max(604800),
});

export const continueWatchingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type ContinueWatchingQuery = z.infer<typeof continueWatchingQuerySchema>;
