/**
 * Seed script — sample catalog + admin account.
 *
 * Run with `npm run db:seed` (maps to `tsx prisma/seed.ts`).
 * Idempotent: uses fixed UUIDs and upserts, so re-running is safe.
 *
 * Creates:
 *   - An admin account (ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD)
 *     with two profiles.
 *   - 6 published movies + 3 published series (with seasons/episodes) + 2
 *     pending titles (for the moderation queue demo).
 *   - READY video assets with renditions for a few titles so playback and
 *     continue-watching can be exercised without running a real transcode.
 */

import { PrismaClient } from '../src/generated/prisma/index.js';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ───────────────────────────── fixed ids ─────────────────────────────

const ID = {
  admin: '00000000-0000-4000-8000-000000000001',
  adminProfile: '00000000-0000-4000-8000-0000000000a1',
  kidsProfile: '00000000-0000-4000-8000-0000000000a2',

  movieAurora: '00000000-0000-4000-8000-000000000010',
  movieNebula: '00000000-0000-4000-8000-000000000011',
  movieCrimson: '00000000-0000-4000-8000-000000000012',
  movieTides: '00000000-0000-4000-8000-000000000013',
  moviePaper: '00000000-0000-4000-8000-000000000014',
  movieVault: '00000000-0000-4000-8000-000000000015',

  seriesLighthouse: '00000000-0000-4000-8000-000000000020',
  seriesWildlands: '00000000-0000-4000-8000-000000000021',
  seriesKitchen: '00000000-0000-4000-8000-000000000022',

  pendingCove: '00000000-0000-4000-8000-000000000030',
  pendingSignal: '00000000-0000-4000-8000-000000000031',

  // seasons / episodes
  lhSeason1: '00000000-0000-4000-8000-0000000000b1',
  lhEp1: '00000000-0000-4000-8000-0000000000c1',
  lhEp2: '00000000-0000-4000-8000-0000000000c2',
  wlSeason1: '00000000-0000-4000-8000-0000000000b3',
  wlEp1: '00000000-0000-4000-8000-0000000000c3',
  wlEp2: '00000000-0000-4000-8000-0000000000c4',
  ktSeason1: '00000000-0000-4000-8000-0000000000b5',
  ktEp1: '00000000-0000-4000-8000-0000000000c5',
  ktEp2: '00000000-0000-4000-8000-0000000000c6',

  // READY assets (fake HLS keys — the API streams from storage; without
  // real segments the player will 404 but every API surface works).
  assetAurora: '00000000-0000-4000-8000-0000000000d1',
  assetNebula: '00000000-0000-4000-8000-0000000000d2',
  assetCrimson: '00000000-0000-4000-8000-0000000000d3',
  assetLhEp1: '00000000-0000-4000-8000-0000000000d4',
  assetLhEp2: '00000000-0000-4000-8000-0000000000d5',
  assetWlEp1: '00000000-0000-4000-8000-0000000000d6',
  assetPaper: '00000000-0000-4000-8000-0000000000d7',
} as const;

const POSTER = 'https://picsum.photos/seed';
const BACKDROP = 'https://picsum.photos/seed';

function renditionSet(assetId: string) {
  const labels = ['240p', '480p', '720p', '1080p'] as const;
  const dims: Record<string, [number, number, number]> = {
    '240p': [426, 240, 400],
    '480p': [854, 480, 1000],
    '720p': [1280, 720, 2500],
    '1080p': [1920, 1080, 5000],
  };
  return labels.map((label) => {
    const [width, height, kbps] = dims[label]!;
    return {
      label,
      width,
      height,
      videoBitrateKbps: kbps,
      audioBitrateKbps: 128,
      codec: 'h264',
      playlistKey: `assets/${assetId}/hls/renditions/${label}/index.m3u8`,
    };
  });
}

async function seedAdmin() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@streamex.dev';
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'Admin123!change-me';
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN' },
    create: {
      id: ID.admin,
      email,
      passwordHash,
      role: 'ADMIN',
      emailVerified: new Date(),
      profiles: {
        create: [
          { id: ID.adminProfile, name: 'Admin', maturity: 100 },
          { id: ID.kidsProfile, name: 'Kids', isKids: true, maturity: 10 },
        ],
      },
    },
  });
  console.log(`admin account ready: ${email}`);
}

interface MovieSeed {
  id: string;
  slug: string;
  name: string;
  year: number;
  rating: string;
  genres: string[];
  tags: string[];
  synopsis: string;
  runtime: number;
  featured?: boolean;
  original?: boolean;
  views: number;
  assetId?: string;
}

const MOVIES: MovieSeed[] = [
  {
    id: ID.movieAurora,
    slug: 'aurora-drift',
    name: 'Aurora Drift',
    year: 2024,
    rating: 'PG-13',
    genres: ['Sci-Fi', 'Drama'],
    tags: ['space', 'isolation', 'hope'],
    synopsis:
      'A lone cartographer aboard a deep-space probe discovers a signal that rewrites the map of the galaxy — and her own past.',
    runtime: 118,
    featured: true,
    original: true,
    views: 158_000,
    assetId: ID.assetAurora,
  },
  {
    id: ID.movieNebula,
    slug: 'nebula-run',
    name: 'Nebula Run',
    year: 2023,
    rating: 'PG-13',
    genres: ['Sci-Fi', 'Action'],
    tags: ['heist', 'space', 'chase'],
    synopsis:
      'Five couriers race across a collapsing nebula with a cargo that three governments would kill to recover.',
    runtime: 106,
    views: 224_500,
    assetId: ID.assetNebula,
  },
  {
    id: ID.movieCrimson,
    slug: 'crimson-harbor',
    name: 'Crimson Harbor',
    year: 2022,
    rating: 'R',
    genres: ['Thriller', 'Crime'],
    tags: ['noir', 'detective', 'port-city'],
    synopsis:
      'A dock inspector with a debt to the wrong people finds a body that doesn\u2019t want to be found.',
    runtime: 131,
    views: 98_700,
    assetId: ID.assetCrimson,
  },
  {
    id: ID.movieTides,
    slug: 'tides-of-march',
    name: 'Tides of March',
    year: 2021,
    rating: 'PG',
    genres: ['Drama', 'Family'],
    tags: ['coast', 'coming-of-age', 'sailing'],
    synopsis:
      'Every spring the ferry brings a new rumour to the island — this year it brings a sister nobody knew existed.',
    runtime: 97,
    views: 45_120,
  },
  {
    id: ID.moviePaper,
    slug: 'paper-lanterns',
    name: 'Paper Lanterns',
    year: 2020,
    rating: 'G',
    genres: ['Animation', 'Family'],
    tags: ['festival', 'children', 'lanterns'],
    synopsis:
      'A shy lantern-maker\u2019s quiet festival is upended when one of his creations learns to fly.',
    runtime: 88,
    original: true,
    views: 76_300,
    assetId: ID.assetPaper,
  },
  {
    id: ID.movieVault,
    slug: 'vault-seven',
    name: 'Vault Seven',
    year: 2019,
    rating: 'TV-MA',
    genres: ['Action', 'Thriller'],
    tags: ['heist', 'underground', 'betrayal'],
    synopsis:
      'The deepest bank vault on earth opens for exactly nine minutes a decade. This decade, someone is waiting inside.',
    runtime: 124,
    views: 132_900,
  },
];

async function seedMovies() {
  for (const m of MOVIES) {
    const existingAsset = m.assetId
      ? {
          id: m.assetId,
          status: 'READY' as const,
          sourceKey: `sources/${m.assetId}/source.mp4`,
          sourceSizeBytes: BigInt(4_200_000_000),
          sourceMime: 'video/mp4',
          container: 'mp4',
          durationSeconds: m.runtime * 60 - 240,
          sourceWidth: 1920,
          sourceHeight: 1080,
          masterPlaylistKey: `assets/${m.assetId}/hls/master.m3u8`,
          thumbnailSpriteKey: `assets/${m.assetId}/hls/sprite.jpg`,
          thumbnailVttKey: `assets/${m.assetId}/hls/thumbs.vtt`,
          processingPercent: 100,
          readyAt: new Date(),
        }
      : undefined;

    await prisma.title.upsert({
      where: { id: m.id },
      update: {},
      create: {
        id: m.id,
        slug: m.slug,
        type: 'MOVIE',
        name: m.name,
        synopsis: m.synopsis,
        releaseYear: m.year,
        rating: m.rating,
        maturityRating: m.rating,
        runtimeMinutes: m.runtime,
        genres: m.genres,
        tags: m.tags,
        cast: ['R. Ellery', 'M. Okafor', 'S. Varga'],
        directors: ['J. Lindqvist'],
        posterUrl: `${POSTER}/${m.slug}-poster/300/450`,
        backdropUrl: `${BACKDROP}/${m.slug}-backdrop/1280/720`,
        isFeatured: m.featured ?? false,
        isOriginal: m.original ?? false,
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        publishedAt: new Date(),
        viewCount: BigInt(m.views),
        ...(existingAsset
          ? {
              videoAssets: {
                create: {
                  ...existingAsset,
                  renditions: { create: renditionSet(m.assetId!) },
                },
              },
            }
          : {}),
      },
    });
  }
  console.log(`seeded ${MOVIES.length} movies`);
}

async function seedSeries() {
  // The Lighthouse — 1 season, 2 episodes
  await prisma.title.upsert({
    where: { id: ID.seriesLighthouse },
    update: {},
    create: {
      id: ID.seriesLighthouse,
      slug: 'the-lighthouse-keepers',
      name: 'The Lighthouse Keepers',
      type: 'SERIES',
      synopsis:
        'Two rival keepers, one impossible light, and a shipping lane that keeps sending its ships to the wrong century.',
      releaseYear: 2025,
      rating: 'TV-14',
      maturityRating: 'TV-14',
      genres: ['Mystery', 'Drama'],
      tags: ['sea', 'lighthouse', 'time-slip'],
      cast: ['A. Duval', 'K. Mbeki'],
      directors: ['P. Sorrentino'],
      posterUrl: `${POSTER}/lighthouse-poster/300/450`,
      backdropUrl: `${BACKDROP}/lighthouse-backdrop/1280/720`,
      isFeatured: true,
      isOriginal: true,
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
      viewCount: BigInt(310_000),
      seasons: {
        create: {
          id: ID.lhSeason1,
          number: 1,
          name: 'Season 1',
          overview: 'The light goes out and the century shifts.',
          episodes: {
            create: [
              {
                id: ID.lhEp1,
                number: 1,
                name: 'First Watch',
                overview: 'Ilsa takes the night shift and inherits a logbook with tomorrow\u2019s dates.',
                runtimeMinutes: 52,
                videoAssets: {
                  create: {
                    id: ID.assetLhEp1,
                    status: 'READY',
                    sourceKey: `sources/${ID.assetLhEp1}/source.mp4`,
                    sourceSizeBytes: BigInt(2_100_000_000),
                    sourceMime: 'video/mp4',
                    container: 'mp4',
                    durationSeconds: 52 * 60 - 30,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                    masterPlaylistKey: `assets/${ID.assetLhEp1}/hls/master.m3u8`,
                    thumbnailSpriteKey: `assets/${ID.assetLhEp1}/hls/sprite.jpg`,
                    thumbnailVttKey: `assets/${ID.assetLhEp1}/hls/thumbs.vtt`,
                    processingPercent: 100,
                    readyAt: new Date(),
                    renditions: { create: renditionSet(ID.assetLhEp1) },
                  },
                },
              },
              {
                id: ID.lhEp2,
                number: 2,
                name: 'Second Watch',
                overview: 'A ship from 1912 answers the modern radio.',
                runtimeMinutes: 49,
                videoAssets: {
                  create: {
                    id: ID.assetLhEp2,
                    status: 'READY',
                    sourceKey: `sources/${ID.assetLhEp2}/source.mp4`,
                    sourceSizeBytes: BigInt(2_000_000_000),
                    sourceMime: 'video/mp4',
                    container: 'mp4',
                    durationSeconds: 49 * 60 - 20,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                    masterPlaylistKey: `assets/${ID.assetLhEp2}/hls/master.m3u8`,
                    thumbnailSpriteKey: `assets/${ID.assetLhEp2}/hls/sprite.jpg`,
                    thumbnailVttKey: `assets/${ID.assetLhEp2}/hls/thumbs.vtt`,
                    processingPercent: 100,
                    readyAt: new Date(),
                    renditions: { create: renditionSet(ID.assetLhEp2) },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

  // Wildlands — 1 season, 2 episodes
  await prisma.title.upsert({
    where: { id: ID.seriesWildlands },
    update: {},
    create: {
      id: ID.seriesWildlands,
      slug: 'wildlands',
      name: 'Wildlands',
      type: 'SERIES',
      synopsis:
        'A veterinary team stitches together a corridor for the last wild elephants while the world redraws borders.',
      releaseYear: 2024,
      rating: 'TV-PG',
      maturityRating: 'TV-PG',
      genres: ['Documentary', 'Nature'],
      tags: ['wildlife', 'conservation', 'elephants'],
      cast: ['Dr. N. Rao'],
      directors: ['L. Zhang'],
      posterUrl: `${POSTER}/wildlands-poster/300/450`,
      backdropUrl: `${BACKDROP}/wildlands-backdrop/1280/720`,
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
      viewCount: BigInt(87_000),
      seasons: {
        create: {
          id: ID.wlSeason1,
          number: 1,
          name: 'Season 1',
          episodes: {
            create: [
              {
                id: ID.wlEp1,
                number: 1,
                name: 'The Corridor',
                overview: 'Mapping a route across three countries and one war.',
                runtimeMinutes: 44,
                videoAssets: {
                  create: {
                    id: ID.assetWlEp1,
                    status: 'READY',
                    sourceKey: `sources/${ID.assetWlEp1}/source.mp4`,
                    sourceSizeBytes: BigInt(1_800_000_000),
                    sourceMime: 'video/mp4',
                    container: 'mp4',
                    durationSeconds: 44 * 60,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                    masterPlaylistKey: `assets/${ID.assetWlEp1}/hls/master.m3u8`,
                    thumbnailSpriteKey: `assets/${ID.assetWlEp1}/hls/sprite.jpg`,
                    thumbnailVttKey: `assets/${ID.assetWlEp1}/hls/thumbs.vtt`,
                    processingPercent: 100,
                    readyAt: new Date(),
                    renditions: { create: renditionSet(ID.assetWlEp1) },
                  },
                },
              },
              {
                id: ID.wlEp2,
                number: 2,
                name: 'The Crossing',
                overview: 'The herd moves at dusk; the permits do not.',
                runtimeMinutes: 41,
              },
            ],
          },
        },
      },
    },
  });

  // Kitchen Tales — kids
  await prisma.title.upsert({
    where: { id: ID.seriesKitchen },
    update: {},
    create: {
      id: ID.seriesKitchen,
      slug: 'kitchen-tales',
      name: 'Kitchen Tales',
      type: 'SERIES',
      synopsis:
        'Chef Pip and a very opinionated sourdough starter turn a tiny bakery into the neighbourhood\u2019s heart.',
      releaseYear: 2023,
      rating: 'TV-Y',
      maturityRating: 'TV-Y',
      genres: ['Animation', 'Family'],
      tags: ['baking', 'kids', 'friendship'],
      cast: ['Pip'],
      directors: ['Studio Miso'],
      posterUrl: `${POSTER}/kitchen-poster/300/450`,
      backdropUrl: `${BACKDROP}/kitchen-backdrop/1280/720`,
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
      viewCount: BigInt(64_000),
      seasons: {
        create: {
          id: ID.ktSeason1,
          number: 1,
          name: 'Season 1',
          episodes: {
            create: [
              { id: ID.ktEp1, number: 1, name: 'The Starter', overview: 'Pip inherits a bubbling jar.', runtimeMinutes: 12 },
              { id: ID.ktEp2, number: 2, name: 'The Loaf', overview: 'Bake day goes wonderfully sideways.', runtimeMinutes: 11 },
            ],
          },
        },
      },
    },
  });
  console.log('seeded 3 series');
}

async function seedPending() {
  for (const t of [
    {
      id: ID.pendingCove,
      slug: 'the-cove-experiment',
      name: 'The Cove Experiment',
      year: 2025,
      rating: 'PG-13',
      genres: ['Sci-Fi'],
      tags: ['ocean', 'experiment'],
      synopsis: 'A sealed sea-cove, nine volunteers, one impossible result.',
    },
    {
      id: ID.pendingSignal,
      slug: 'signal-lost',
      name: 'Signal Lost',
      year: 2026,
      rating: 'TV-14',
      genres: ['Thriller'],
      tags: ['radio', 'isolation'],
      synopsis: 'The last broadcast from station K-9 is a recipe for pie.',
    },
  ]) {
    await prisma.title.upsert({
      where: { id: t.id },
      update: {},
      create: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        synopsis: t.synopsis,
        releaseYear: t.year,
        rating: t.rating,
        maturityRating: t.rating,
        genres: t.genres,
        tags: t.tags,
        posterUrl: `${POSTER}/${t.slug}-poster/300/450`,
        status: 'PENDING',
        moderationStatus: 'PENDING',
        moderationItems: { create: {} },
      },
    });
  }
  console.log('seeded 2 pending moderation items');
}

async function main() {
  console.log('seeding StreamEX…');
  await seedAdmin();
  await seedMovies();
  await seedSeries();
  await seedPending();
  console.log('seed complete');
}

main()
  .catch((err) => {
    console.error('seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
