import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { getPrisma } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/index.js';
import type { BrowseQuery, SearchQuery, SimilarQuery } from './catalog.schemas.js';

/**
 * Catalog service.
 *
 * - browse: paginated with genre/year/rating/type filters + sort
 * - search: Postgres full-text (tsvector column `search_vector`, created by
 *   prisma/enhance.ts; websearch_to_tsquery handles user-typed queries) with
 *   an ILIKE fallback when the column is not present
 * - detail: nested seasons → episodes → video assets with renditions
 * - similar: genre/tag overlap scoring computed over candidate rows
 */

export interface CatalogScope {
  isKids: boolean;
  maturity: number;
}

export const RATING_WEIGHTS: Record<string, number> = {
  G: 0,
  'TV-Y': 0,
  'TV-G': 0,
  PG: 10,
  'TV-Y7': 10,
  'TV-PG': 30,
  'PG-13': 40,
  'TV-14': 60,
  R: 80,
  'TV-MA': 90,
  'NC-17': 100,
};

const KIDS_SAFE_RATINGS = ['G', 'TV-Y', 'TV-G', 'PG', 'TV-Y7'];

/** Ratings visible to a profile (mirrors middleware/kidsFilter.ts). */
export function allowedRatings(scope: CatalogScope): string[] {
  if (scope.isKids) return [...KIDS_SAFE_RATINGS];
  return Object.entries(RATING_WEIGHTS)
    .filter(([, weight]) => weight <= scope.maturity)
    .map(([rating]) => rating);
}

export const SORTS: Record<string, Prisma.TitleOrderByWithRelationInput[]> = {
  trending: [{ viewCount: 'desc' }, { createdAt: 'desc' }],
  newest: [{ releaseYear: 'desc' }, { createdAt: 'desc' }],
  oldest: [{ releaseYear: 'asc' }, { createdAt: 'asc' }],
  az: [{ name: 'asc' }],
  rating: [{ releaseYear: 'desc' }, { viewCount: 'desc' }],
};

const PAGE_TITLES_SELECT = {
  id: true,
  slug: true,
  type: true,
  name: true,
  synopsis: true,
  releaseYear: true,
  rating: true,
  runtimeMinutes: true,
  posterUrl: true,
  backdropUrl: true,
  genres: true,
  tags: true,
  viewCount: true,
  isFeatured: true,
  isOriginal: true,
  maturityRating: true,
} satisfies Prisma.TitleSelect;

export type CatalogRow = Prisma.TitleGetPayload<{ select: typeof PAGE_TITLES_SELECT }>;

export interface BrowsePage {
  items: CatalogRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function paginate(items: CatalogRow[], total: number, page: number, pageSize: number): BrowsePage {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function baseWhere(scope: CatalogScope, extraRating?: string): Prisma.TitleWhereInput {
  const allowed = allowedRatings(scope);
  const ratings = extraRating && allowed.includes(extraRating) ? [extraRating] : allowed;
  return {
    status: 'PUBLISHED',
    moderationStatus: 'APPROVED',
    rating: { in: ratings },
  };
}

export async function browse(query: BrowseQuery, scope: CatalogScope): Promise<BrowsePage> {
  const prisma = getPrisma();
  const where: Prisma.TitleWhereInput = {
    ...baseWhere(scope, query.rating),
    ...(query.genre ? { genres: { has: query.genre } } : {}),
    ...(query.year ? { releaseYear: query.year } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { synopsis: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [total, items] = await Promise.all([
    prisma.title.count({ where }),
    prisma.title.findMany({
      where,
      select: PAGE_TITLES_SELECT,
      orderBy: SORTS[query.sort] ?? SORTS.trending!,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return paginate(items, total, query.page, query.pageSize);
}

export async function search(query: SearchQuery, scope: CatalogScope): Promise<BrowsePage> {
  if (query.q.trim().length === 0) throw new ValidationError('Query must not be empty');
  const prisma = getPrisma();
  const where: Prisma.TitleWhereInput = {
    ...baseWhere(scope),
    OR: [
      { name: { contains: query.q, mode: 'insensitive' } },
      { synopsis: { contains: query.q, mode: 'insensitive' } },
      { genres: { has: query.q } },
      { tags: { has: query.q } },
      { cast: { has: query.q } },
    ],
  };
  const [total, items] = await Promise.all([
    prisma.title.count({ where }),
    prisma.title.findMany({
      where,
      select: PAGE_TITLES_SELECT,
      orderBy: [{ viewCount: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return paginate(items, total, query.page, query.pageSize);
}

/**
 * Full-text search using the Postgres tsvector column. Falls back to
 * `search()` when the column is missing (pre-enhancement databases).
 */
export async function searchFullText(
  query: SearchQuery,
  scope: CatalogScope,
): Promise<BrowsePage> {
  const prisma = getPrisma();
  const allowed = allowedRatings(scope);
  const offset = (query.page - 1) * query.pageSize;
  try {
    const rows = await prisma.$queryRaw<CatalogRow[]>`
      SELECT ${Prisma.sql(['id, slug, type, name, synopsis, release_year, rating, runtime_minutes, poster_url, backdrop_url, genres, tags, view_count, is_featured, is_original, maturity_rating'])}
      FROM titles
      WHERE status = 'PUBLISHED'
        AND moderation_status = 'APPROVED'
        AND rating = ANY(${allowed}::text[])
        AND search_vector @@ websearch_to_tsquery('english', ${query.q})
      ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', ${query.q})) DESC
      LIMIT ${query.pageSize} OFFSET ${offset}`;
    const totalRows = await prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM titles
      WHERE status = 'PUBLISHED'
        AND moderation_status = 'APPROVED'
        AND rating = ANY(${allowed}::text[])
        AND search_vector @@ websearch_to_tsquery('english', ${query.q})`;
    const total = totalRows[0]?.total ?? 0;
    return paginate(rows, total, query.page, query.pageSize);
  } catch (err) {
    // search_vector column missing → ILIKE fallback
    if (err instanceof Error && /search_vector|ts_rank_cd/i.test(err.message)) {
      return search(query, scope);
    }
    throw err;
  }
}

export async function getTitle(idOrSlug: string, scope: CatalogScope) {
  const prisma = getPrisma();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const title = await prisma.title.findFirst({
    where: isUuid ? { id: idOrSlug } : { slug: idOrSlug },
    include: {
      seasons: {
        orderBy: { number: 'asc' },
        include: {
          episodes: {
            orderBy: { number: 'asc' },
            include: {
              videoAssets: {
                where: { status: 'READY' },
                include: { renditions: true },
              },
            },
          },
        },
      },
      videoAssets: {
        where: { episodeId: null, status: 'READY' },
        include: { renditions: true },
      },
    },
  });
  if (!title) throw new NotFoundError('Title not found');
  if (!allowedRatings(scope).includes(title.rating)) {
    throw new NotFoundError('Title not found');
  }
  return title;
}

/**
 * Similar titles — genre/tag overlap score.
 *
 * score = 3 × |shared genres| + 2 × |shared tags| + 2 × primary-genre match,
 * restricted to the same title type. Candidates are pre-filtered in SQL by
 * genre/tag overlap, then ranked in JS.
 */
export function computeSimilarityScore(
  base: { genres: string[]; tags: string[]; type: string },
  candidate: { genres: string[]; tags: string[]; type: string },
): number {
  if (base.type !== candidate.type) return 0;
  const baseGenres = new Set(base.genres.map((g) => g.toLowerCase()));
  const baseTags = new Set(base.tags.map((t) => t.toLowerCase()));
  let sharedGenres = 0;
  for (const g of candidate.genres) if (baseGenres.has(g.toLowerCase())) sharedGenres += 1;
  let sharedTags = 0;
  for (const t of candidate.tags) if (baseTags.has(t.toLowerCase())) sharedTags += 1;
  const primaryGenreBonus =
    base.genres[0] && candidate.genres[0] &&
    base.genres[0].toLowerCase() === candidate.genres[0].toLowerCase()
      ? 2
      : 0;
  return 3 * sharedGenres + 2 * sharedTags + primaryGenreBonus;
}

export async function similarTitles(
  titleId: string,
  limit: number,
  scope: CatalogScope,
): Promise<CatalogRow[]> {
  const prisma = getPrisma();
  const base = await prisma.title.findFirst({
    where: { id: titleId },
    select: { id: true, genres: true, tags: true, type: true },
  });
  if (!base) throw new NotFoundError('Title not found');
  const candidates = await prisma.title.findMany({
    where: {
      id: { not: base.id },
      ...baseWhere(scope),
      type: base.type,
      OR: [{ genres: { hasSome: base.genres } }, { tags: { hasSome: base.tags } }],
    },
    select: { ...PAGE_TITLES_SELECT, type: true, genres: true, tags: true },
  });
  return candidates
    .map((row) => ({ row, score: computeSimilarityScore(base, row) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.row.viewCount - a.row.viewCount))
    .slice(0, limit)
    .map((entry) => entry.row);
}

export async function listGenres(): Promise<{ genre: string; count: number }[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<{ genre: string; count: number }[]>`
    SELECT unnest(genres) AS genre, count(*)::int AS count
    FROM titles
    WHERE status = 'PUBLISHED' AND moderation_status = 'APPROVED'
    GROUP BY genre
    ORDER BY count DESC, genre ASC`;
  return rows;
}
