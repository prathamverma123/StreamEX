import { getPrisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { WatchlistAddInput, WatchlistQuery } from './watchlist.schemas.js';

/**
 * Watchlist service — per-user saved titles with dedupe on (userId, titleId).
 */

export async function add(userId: string, input: WatchlistAddInput) {
  const prisma = getPrisma();
  const title = await prisma.title.findFirst({
    where: { id: input.titleId, status: 'PUBLISHED', moderationStatus: 'APPROVED' },
  });
  if (!title) throw new NotFoundError('Title not found');
  const existing = await prisma.watchlistEntry.findUnique({
    where: { userId_titleId: { userId, titleId: input.titleId } },
  });
  if (existing) {
    throw new ConflictError('Title is already in the watchlist');
  }
  const entry = await prisma.watchlistEntry.create({
    data: { userId, titleId: input.titleId },
    include: { title: { select: { id: true, name: true, posterUrl: true, type: true } } },
  });
  return entry;
}

export async function remove(userId: string, titleId: string) {
  const prisma = getPrisma();
  const entry = await prisma.watchlistEntry.findUnique({
    where: { userId_titleId: { userId, titleId } },
  });
  if (!entry) throw new NotFoundError('Title is not in the watchlist');
  await prisma.watchlistEntry.delete({ where: { id: entry.id } });
}

export async function list(userId: string, query: WatchlistQuery) {
  const prisma = getPrisma();
  const where = { userId };
  const [total, items] = await Promise.all([
    prisma.watchlistEntry.count({ where }),
    prisma.watchlistEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        title: {
          select: {
            id: true, name: true, slug: true, type: true, posterUrl: true,
            backdropUrl: true, rating: true, releaseYear: true, genres: true,
            runtimeMinutes: true, synopsis: true,
          },
        },
      },
    }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function has(userId: string, titleId: string): Promise<boolean> {
  const prisma = getPrisma();
  const entry = await prisma.watchlistEntry.findUnique({
    where: { userId_titleId: { userId, titleId } },
  });
  return entry !== null;
}
