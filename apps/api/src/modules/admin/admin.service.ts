import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { getPrisma } from '../../lib/prisma.js';
import { enqueueTranscode } from '../../queues/producer.js';
import type {
  BulkUploadInput,
  CreateAssetInput,
  ModerationPatchInput,
  ModerationQuery,
} from './admin.schemas.js';

/**
 * Admin service — content ingestion, asset creation, moderation queue.
 */

export interface BulkResult {
  ingestionId: string;
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: { row: number; slug?: string; message: string }[];
}

export async function bulkUploadTitles(userId: string, input: BulkUploadInput): Promise<BulkResult> {
  const prisma = getPrisma();
  const errors: BulkResult['errors'] = [];
  let created = 0;
  let updated = 0;

  for (let i = 0; i < input.titles.length; i += 1) {
    const row = input.titles[i]!;
    try {
      await prisma.title.upsert({
        where: { slug: row.slug },
        create: {
          slug: row.slug,
          name: row.name,
          type: row.type,
          synopsis: row.synopsis,
          releaseYear: row.releaseYear,
          rating: row.rating,
          runtimeMinutes: row.runtimeMinutes,
          genres: row.genres,
          tags: row.tags,
          cast: row.cast,
          directors: row.directors,
          posterUrl: row.posterUrl,
          backdropUrl: row.backdropUrl,
          trailerUrl: row.trailerUrl,
          isFeatured: row.isFeatured,
          isOriginal: row.isOriginal,
          originalLanguage: row.originalLanguage,
          status: row.status,
          moderationStatus: row.status === 'PUBLISHED' ? 'APPROVED' : 'PENDING',
          publishedAt: row.status === 'PUBLISHED' ? new Date() : null,
        },
        update: {
          name: row.name,
          type: row.type,
          synopsis: row.synopsis,
          releaseYear: row.releaseYear,
          rating: row.rating,
          runtimeMinutes: row.runtimeMinutes,
          genres: row.genres,
          tags: row.tags,
          cast: row.cast,
          directors: row.directors,
          posterUrl: row.posterUrl,
          backdropUrl: row.backdropUrl,
          trailerUrl: row.trailerUrl,
          isFeatured: row.isFeatured,
          isOriginal: row.isOriginal,
          originalLanguage: row.originalLanguage,
          status: row.status,
        },
      });
      if (row.status === 'PUBLISHED') {
        // upsert does not tell us create vs update — probe.
        const existing = await prisma.title.findUnique({ where: { slug: row.slug } });
        if (existing && existing.createdAt.getTime() === existing.updatedAt.getTime()) {
          created += 1;
        } else {
          updated += 1;
        }
      } else {
        updated += 1;
      }
    } catch (err) {
      errors.push({
        row: i,
        slug: row.slug,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ingestion = await prisma.bulkIngestion.create({
    data: {
      userId,
      filename: 'inline-json',
      totalRows: input.titles.length,
      successRows: created + updated,
      failedRows: errors.length,
      errorsJson: errors,
    },
  });

  return {
    ingestionId: ingestion.id,
    total: input.titles.length,
    created,
    updated,
    failed: errors.length,
    errors,
  };
}

export async function createAsset(userId: string, input: CreateAssetInput) {
  const prisma = getPrisma();
  const title = await prisma.title.findFirst({ where: { id: input.titleId } });
  if (!title) throw new NotFoundError('Title not found');
  if (input.episodeId) {
    const episode = await prisma.episode.findFirst({
      where: { id: input.episodeId, season: { titleId: input.titleId } },
    });
    if (!episode) throw new NotFoundError('Episode not found for this title');
  }
  const asset = await prisma.videoAsset.create({
    data: {
      titleId: input.titleId,
      episodeId: input.episodeId ?? null,
      status: 'UPLOADING',
      sourceKey: '', // set by the upload init endpoint
      sourceSizeBytes: BigInt(input.totalBytes),
      sourceMime: input.sourceMime ?? null,
      uploadedById: userId,
    },
  });
  return asset;
}

export async function listModeration(query: ModerationQuery) {
  const prisma = getPrisma();
  const where = { status: query.status };
  const [total, items] = await Promise.all([
    prisma.moderationItem.count({ where }),
    prisma.moderationItem.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { title: { select: { id: true, slug: true, name: true, posterUrl: true } } },
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

export async function reviewModeration(
  reviewerId: string,
  itemId: string,
  input: ModerationPatchInput,
) {
  const prisma = getPrisma();
  const item = await prisma.moderationItem.findUnique({ where: { id: itemId } });
  if (!item) throw new NotFoundError('Moderation item not found');
  if (item.status !== 'PENDING') throw new ConflictError('Item already reviewed');
  const nextStatus = input.action === 'approve' ? 'APPROVED' : 'REJECTED';
  const [updated] = await prisma.$transaction([
    prisma.moderationItem.update({
      where: { id: itemId },
      data: {
        status: nextStatus,
        notes: input.notes,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
      },
    }),
    prisma.title.update({
      where: { id: item.titleId },
      data: {
        moderationStatus: nextStatus,
        ...(input.action === 'approve'
          ? { status: 'PUBLISHED', publishedAt: new Date() }
          : { status: 'ARCHIVED' }),
      },
    }),
  ]);
  return updated;
}

/** Queue a moderation item when a title enters PENDING state. */
export async function ensureModerationItem(titleId: string) {
  const prisma = getPrisma();
  const existing = await prisma.moderationItem.findUnique({ where: { titleId } });
  if (existing) return existing;
  return prisma.moderationItem.create({ data: { titleId } });
}

/** Re-enqueue helper for the runbook (failed transcode recovery). */
export async function requeueAsset(assetId: string) {
  const prisma = getPrisma();
  const asset = await prisma.videoAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new NotFoundError('Asset not found');
  if (asset.status !== 'FAILED' && asset.status !== 'READY') {
    throw new ConflictError('Only FAILED assets can be requeued');
  }
  await prisma.videoAsset.update({
    where: { id: assetId },
    data: { status: 'PROCESSING', processingPercent: 0, errorMessage: null, attempts: 0 },
  });
  await enqueueTranscode({ assetId, sourceKey: asset.sourceKey });
  return { assetId, queued: true };
}
