import { z } from 'zod';

export const bulkTitleRowSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'slug must be kebab-case'),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['MOVIE', 'SERIES']).default('MOVIE'),
  synopsis: z.string().trim().max(4000).default(''),
  releaseYear: z.number().int().min(1900).max(2100),
  rating: z.string().trim().max(12).default('PG-13'),
  runtimeMinutes: z.number().int().min(1).max(1200).optional(),
  genres: z.array(z.string().trim().min(1).max(48)).max(12).default([]),
  tags: z.array(z.string().trim().min(1).max(48)).max(24).default([]),
  cast: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  directors: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  posterUrl: z.string().url().optional(),
  backdropUrl: z.string().url().optional(),
  trailerUrl: z.string().url().optional(),
  isFeatured: z.boolean().default(false),
  isOriginal: z.boolean().default(false),
  originalLanguage: z.string().length(2).default('en'),
  status: z.enum(['PENDING', 'PUBLISHED', 'ARCHIVED']).default('PENDING'),
});

export const bulkUploadSchema = z.object({
  titles: z.array(bulkTitleRowSchema).min(1).max(500),
});

export const createAssetSchema = z.object({
  titleId: z.string().uuid(),
  episodeId: z.string().uuid().optional(),
  filename: z.string().trim().min(1).max(255),
  totalBytes: z.number().int().min(1),
  sourceMime: z.string().trim().max(128).optional(),
});

export const moderationPatchSchema = z.object({
  action: z.enum(['approve', 'reject']),
  notes: z.string().trim().max(2000).optional(),
});

export const moderationQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type BulkTitleRow = z.infer<typeof bulkTitleRowSchema>;
export type BulkUploadInput = z.infer<typeof bulkUploadSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type ModerationPatchInput = z.infer<typeof moderationPatchSchema>;
export type ModerationQuery = z.infer<typeof moderationQuerySchema>;

// ─── Resumable upload ───────────────────────────────────────────────────

export const uploadInitSchema = z.object({
  assetId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  totalBytes: z.number().int().min(1),
  chunkSize: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(8 * 1024 * 1024),
});

export const uploadCompleteSchema = z.object({
  etag: z.string().trim().max(128).optional(),
});

export type UploadInitInput = z.infer<typeof uploadInitSchema>;
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;
