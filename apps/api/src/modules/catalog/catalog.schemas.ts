import { z } from 'zod';

export const browseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(20),
  genre: z.string().trim().max(48).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  rating: z.string().trim().max(12).optional(),
  type: z.enum(['MOVIE', 'SERIES']).optional(),
  sort: z.enum(['trending', 'newest', 'oldest', 'az', 'rating']).default('trending'),
  q: z.string().trim().max(120).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(20),
});

export const similarQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export type BrowseQuery = z.infer<typeof browseQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SimilarQuery = z.infer<typeof similarQuerySchema>;
