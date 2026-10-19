import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as service from './catalog.service.js';
import {
  browseQuerySchema,
  searchQuerySchema,
  similarQuerySchema,
} from './catalog.schemas.js';

/**
 * Catalog controller.
 *
 * Scope resolution: the X-Profile-Id header (validated by attachProfile)
 * determines kids mode + maturity. Without a profile the catalog serves the
 * adult default (maturity 100, no kids filter).
 */

function scopeFrom(req: Request): service.CatalogScope {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (req.profile) {
    return { isKids: req.profile.isKids, maturity: req.profile.maturity };
  }
  return { isKids: false, maturity: 100 };
}

export const browse = asyncHandler(async (req: Request, res: Response) => {
  const query = browseQuerySchema.parse(req.query);
  const page = await service.browse(query, scopeFrom(req));
  res.json(page);
});

export const search = asyncHandler(async (req: Request, res: Response) => {
  const query = searchQuerySchema.parse(req.query);
  const page = await service.searchFullText(query, scopeFrom(req));
  res.json(page);
});

export const getTitle = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeFrom(req);
  const title = await service.getTitle(String(req.params.id), scope);
  res.json({ title });
});

export const similar = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeFrom(req);
  const { limit } = similarQuerySchema.parse(req.query);
  const items = await service.similarTitles(String(req.params.id), limit, scope);
  res.json({ items });
});

export const genres = asyncHandler(async (_req: Request, res: Response) => {
  const items = await service.listGenres();
  res.json({ genres: items });
});

/** Featured hero banner rows (isFeatured + trending fallback). */
export const hero = asyncHandler(async (req: Request, res: Response) => {
  const scope = scopeFrom(req);
  const page = await service.browse({ page: 1, pageSize: 10, sort: 'trending' }, scope);
  const featured = page.items.filter((t) => t.isFeatured);
  res.json({ items: featured.length > 0 ? featured : page.items.slice(0, 3) });
});
