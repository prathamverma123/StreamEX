import { z } from 'zod';

export const profileCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  avatarUrl: z.string().url().max(512).optional(),
  isKids: z.boolean().default(false),
  language: z.string().length(2).default('en'),
  maturity: z.number().int().min(0).max(100).default(100),
  autoplayNext: z.boolean().default(true),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().url().max(512).nullish(),
  isKids: z.boolean().optional(),
  language: z.string().length(2).optional(),
  maturity: z.number().int().min(0).max(100).optional(),
  autoplayNext: z.boolean().optional(),
});

export type ProfileCreateInput = z.infer<typeof profileCreateSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
