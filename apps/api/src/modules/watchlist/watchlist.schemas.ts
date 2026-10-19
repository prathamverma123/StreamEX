import { z } from 'zod';

export const watchlistAddSchema = z.object({
  titleId: z.string().uuid(),
});

export const watchlistQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(20),
});

export type WatchlistAddInput = z.infer<typeof watchlistAddSchema>;
export type WatchlistQuery = z.infer<typeof watchlistQuerySchema>;
