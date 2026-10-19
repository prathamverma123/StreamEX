import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as service from './profiles.service.js';
import { profileCreateSchema, profileUpdateSchema } from './profiles.schemas.js';

export const listProfiles = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const profiles = await service.listProfiles(req.user.id);
  res.json({ profiles });
});

export const createProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const input = profileCreateSchema.parse(req.body);
  const profile = await service.createProfile(req.user.id, input);
  res.status(201).json({ profile });
});

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const profile = await service.getProfile(req.user.id, String(req.params.id));
  res.json({ profile });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const input = profileUpdateSchema.parse(req.body);
  const profile = await service.updateProfile(req.user.id, String(req.params.id), input);
  res.json({ profile });
});

export const deleteProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  await service.deleteProfile(req.user.id, String(req.params.id));
  res.status(204).send();
});
