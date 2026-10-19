import type { Prisma } from '../generated/prisma/index.js';
import { RATING_WEIGHTS } from '../modules/catalog/catalog.service.js';

/**
 * Kids-mode content filter.
 *
 * Attaches `req.profile` context when the X-Profile-Id header is present, and
 * exposes `kidsScope()` which returns a Prisma `where` fragment restricting
 * catalog queries to kids-safe content.
 *
 * Rating weights live in catalog.service.ts (single source of truth) and are
 * re-exported here for convenience.
 */

export { RATING_WEIGHTS };

/** Ratings visible to a profile with the given maturity weight. */
export function allowedRatings(isKids: boolean, maturity: number): string[] {
  const kidsSafe = ['G', 'TV-Y', 'TV-G', 'PG', 'TV-Y7'];
  if (isKids) return kidsSafe;
  return Object.entries(RATING_WEIGHTS)
    .filter(([, weight]) => weight <= maturity)
    .map(([rating]) => rating);
}

/** Prisma where-fragment scoping a catalog query to the profile. */
export function kidsScope(
  isKids: boolean,
  maturity: number,
): Prisma.TitleWhereInput {
  return {
    rating: { in: allowedRatings(isKids, maturity) },
    ...(isKids ? { moderationStatus: 'APPROVED', status: 'PUBLISHED' } : {}),
  };
}

/** True when the title is playable for the profile. */
export function isPlayableForProfile(
  title: { rating: string; moderationStatus?: string; status?: string },
  isKids: boolean,
  maturity: number,
): boolean {
  const allowed = new Set(allowedRatings(isKids, maturity));
  if (!allowed.has(title.rating)) return false;
  if (isKids && title.moderationStatus !== 'APPROVED') return false;
  return true;
}
