/**
 * Schema enhancements that Prisma cannot express.
 *
 * Run with `npm run db:enhance` (maps to `tsx prisma/enhance.ts`).
 * Idempotent: every statement uses IF NOT EXISTS / guarded checks.
 *
 * Adds:
 *   1. titles.search_vector  — tsvector column fed by name + synopsis +
 *      genres + tags + cast, kept in sync by trigger.
 *   2. GIN index on search_vector for fast full-text search.
 *   3. Partial unique index (profile_id, title_id) WHERE episode_id IS NULL
 *      — the invariant the watch-progress upsert relies on (Prisma cannot
 *      create partial unique indexes).
 *   4. Prune expired sessions / reset tokens + upload sessions (housekeeping).
 */

import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

async function run(): Promise<void> {
  // ── 1. Full-text search vector ─────────────────────────────────────
  await prisma.$executeRaw`
    ALTER TABLE titles
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(synopsis, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(array_to_string(genres, ' '), '')), 'C') ||
      setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'C') ||
      setweight(to_tsvector('english', coalesce(array_to_string(cast, ' '), '')), 'C')
    ) STORED`;

  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS titles_search_vector_idx
    ON titles USING GIN (search_vector)`;

  // ── 2. Partial unique index for movie watch progress ────────────────
  await prisma.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS watch_progress_profile_title_no_episode
    ON watch_progress (profile_id, title_id)
    WHERE episode_id IS NULL`;

  // ── 3. Housekeeping: expired sessions / reset tokens / uploads ────
  const prunedSessions = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  const prunedResets = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  const prunedUploads = await prisma.uploadSession.deleteMany({
    where: {
      status: 'ACTIVE',
      createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  console.log(
    `enhance complete — pruned ${prunedSessions.count} sessions, ` +
      `${prunedResets.count} reset tokens, ${prunedUploads.count} stale uploads`,
  );
}

run()
  .catch((err) => {
    console.error('enhance failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
