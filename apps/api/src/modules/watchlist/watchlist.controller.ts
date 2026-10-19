import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as service from './watchlist.service.js';
import { watchlistAddSchema, watchlistQuerySchema } from './watchlist.schemas.js';

export const add = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const input = watchlistAddSchema.parse(req.body);
  const entry = await service.add(req.user.id, input);
  res.status(201).json({ entry });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  await service.remove(req.user.id, String(req.params.titleId));
  res.status(204).send();
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const query = watchlistQuerySchema.parse(req.query);
  const page = await service.list(req.user.id, query);
  res.json(page);
});

export const check = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const inList = await service.has(req.user.id, String(req.params.titleId));
  res.json({ inWatchlist: inList });
});
