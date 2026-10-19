import { z } from 'zod';

export const manifestQuerySchema = z.object({
  /** Client bandwidth hint in bits per second (from the player's estimate). */
  bandwidth: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
  /** Device pixel width, helps pick a ceiling rung on small screens. */
  deviceWidth: z.coerce.number().int().min(1).max(16000).optional(),
});

export type ManifestQuery = z.infer<typeof manifestQuerySchema>;

export const startPlaybackSchema = z.object({
  assetId: z.string().uuid(),
  /** Client bandwidth hint (bps) used for rendition pre-selection. */
  bandwidth: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
  deviceWidth: z.coerce.number().int().min(1).max(16000).optional(),
});

export type StartPlaybackInput = z.infer<typeof startPlaybackSchema>;
