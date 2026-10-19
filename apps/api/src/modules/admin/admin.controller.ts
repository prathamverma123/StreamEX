import type { Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as service from './admin.service.js';
import {
  bulkUploadSchema,
  createAssetSchema,
  moderationPatchSchema,
  moderationQuerySchema,
} from './admin.schemas.js';

/**
 * Admin controller. Route-level admin gating happens in admin.routes.ts
 * (authenticate + requireAdmin); the controller double-checks defensively.
 */

function requireAdmin(req: Request) {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (req.user.role !== 'ADMIN') throw new ForbiddenError('Admin role required');
  return req.user;
}

export const bulkUploadTitles = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAdmin(req);
  const input = bulkUploadSchema.parse(req.body);
  const result = await service.bulkUploadTitles(user.id, input);
  res.status(200).json(result);
});

export const createAsset = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAdmin(req);
  const input = createAssetSchema.parse(req.body);
  const asset = await service.createAsset(user.id, input);
  res.status(201).json({ asset });
});

export const listModeration = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const query = moderationQuerySchema.parse(req.query);
  const page = await service.listModeration(query);
  res.json(page);
});

export const reviewModeration = asyncHandler(async (req: Request, res: Response) => {
  const user = requireAdmin(req);
  const input = moderationPatchSchema.parse(req.body);
  const item = await service.reviewModeration(user.id, String(req.params.id), input);
  res.json({ item });
});

export const requeueAsset = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const result = await service.requeueAsset(String(req.params.assetId));
  res.json(result);
});
