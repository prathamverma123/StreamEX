# StreamEX Architecture

How the pieces fit, why they are the way they are, and the decisions worth
knowing before changing anything.

```
                        ┌──────────────────────────────────────────┐
                        │                nginx (8080)               │
                        │  TLS · CORS · range reqs · HLS caching  │
                        └───────┬──────────────────────┬───────────┘
                                │ REST/WS              │ /hls/*
                    ┌───────────▼────────┐   ┌────────▼─────────┐
                    │   API (Express)     │   │ static volume /  │
                    │  auth · catalog ·   │   │ S3 presigned     │
                    │  playback · admin   │   └────────▲─────────┘
                    └───┬─────────┬───────┘            │
                        │         │                    │
             Prisma ────┘         └──── BullMQ ────────┼────┐
                        │                (Redis)      │    │ enqueues
                        │                             │    ▼
                 ┌──────▼──────┐              ┌────────┴──────────────┐
                 │  Postgres   │              │  Worker (BullMQ)     │
                 │ titles ·    │◄─────────────│  ffprobe → ladder → │
                 │ assets ·    │  renditions  │  ffmpeg → sprite →  │
                 │ sessions …  │  rows        │  subtitles → master  │
                 └─────────────┘              └─────────────────────┘
                        ▲                              │
                        │  progress %, retries, DLQ    │
                        │  via Redis pub/sub          ▼
                        │                     storage abstraction
                 ┌──────┴───────┐            (local FS | S3)
                 │    Redis     │◄───────────────┘
                 │ BullMQ +    │
                 │ pub/sub     │
                 └─────────────┘
```

## Monorepo layout

```
apps/api      Express + TS + Prisma REST + Socket.io server
apps/worker   BullMQ consumer: ffprobe → transcode → package (ffmpeg CLI)
packages/storage   Storage backend abstraction (local FS | S3) — one interface
docs/         this documentation
deploy/nginx  reverse-proxy config (CORS, range requests, HLS cache)
.github/workflows  ci.yml (lint/type/test + docker build) · release-worker-exe.yml
scripts/copy-prisma-assets.mjs  mirrors the generated Prisma client into dist/
```

Workspaces are npm-managed (`npm ci --workspaces`). `@streamex/storage` is a
real package both apps import; the worker additionally imports the API's
**generated Prisma client** (`apps/api/src/generated/prisma`) so there is
exactly one client definition for the shared schema.

## The two invariants

Two structural facts drive most of the build/packaging code. Internalize them
before touching Dockerfiles or scripts:

### 1. The generated Prisma client is a source-of-truth singleton

`schema.prisma` declares `output = "../src/generated/prisma"` — the client is
generated **into the source tree** and committed. Every `import { PrismaClient }
from '../generated/prisma/index.js'` (API) and
`'../../api/src/generated/prisma/index.js'` (worker) resolves to it. Consequences:

- `npm ci` alone never creates it; `prisma generate` (or the root `postinstall`)
  must run after any clean install.
- `tsc` **does not copy non-TS assets**, so when the API compiles, the emitted
  `dist/lib/prisma.js` does `require('../generated/prisma/index.js')` —
  resolved **inside dist/**. Without a mirror step the compiled server cannot
  even boot. `scripts/copy-prisma-assets.mjs` (wired into root
  `npm run build`, and into both Docker build stages) copies the generated
  client into `apps/api/dist/generated/prisma` after compiling. The compiled
  worker bakes in `../../api/src/generated/...`, so the worker image also
  restores `apps/api/src/generated` into the runner.

### 2. `npm ci` in a fresh container cannot run lifecycle scripts

The root `prepare` builds `@streamex/storage` and `postinstall` runs
`prisma generate`. In a Docker deps stage only package.json files exist, so
both scripts fail. Every `npm ci` in both Dockerfiles therefore uses
`--ignore-scripts`, and generation/building happens explicitly:

```
npm ci --ignore-scripts --workspaces
npx prisma generate --schema=apps/api/prisma/schema.prisma
npm run build --workspace @streamex/storage
npm run build --workspace @streamex/api
node scripts/copy-prisma-assets.mjs
```

## Auth design

- **Access token**: JWT HS256, 15m TTL, claims `{ sub, email, role, kid }`.
  Statelessness means horizontal scale for free.
- **Refresh token**: opaque 256-bit random value, stored **hashed** (SHA-256)
  in `sessions`. Rotation on every `/auth/refresh` — the presented token is
  marked used and a new one issued. **Reuse detection**: if an
  already-rotated token is presented, the entire session family is revoked
  and the caller gets `410 GONE`, on the assumption the token was stolen.
- **Key rotation**: `JWT_*_SECRET_PREVIOUS`/`JWT_PREVIOUS_KID` keep the
  previous key valid for verification during a rotation window — signing
  always uses the current key/kid.
- **Rate limiting** is Redis-backed fixed-window (`rateLimit` middleware),
  with separate buckets for auth endpoints (10/60s) to blunt credential
  stuffing; health probes are exempt so orchestrators never get throttled.

## Profiles & kids mode

`profiles.is_kids` is the single switch. `attachProfile` middleware loads the
profile on every profile-scoped request; kids profiles get a server-enforced
`maturityRating <= PG` ceiling plus excluded-genre filtering in catalog
queries, and a 720p rendition cap in playback. Nothing trust-the-client about
it — a kids profile cannot fetch a restricted manifest even with a crafted
request, because the ceiling is stamped into the HMAC-signed HLS token.

## Transcoding pipeline

```
enqueue (API) → BullMQ 'transcode' queue
  → worker pickup (lock, attempts)
  → ffprobe  (duration, size, codec, bitrate)
  → ladder selection  (skip rungs > source height; 4K only if
                        TRANSCODE_ENABLE_4K and source ≥ 2160p)
  → per-rung ffmpeg (video bitrate, -2 height scale, keyframe-aligned
                     GOP = TRANSCODE_KEYFRAME_SECONDS, x264 preset)
  → thumbnail sprite (1 frame per SPRITE_FRAME_INTERVAL_SECONDS,
                      SPRITE_TILE_WIDTH×SPRITE_TILE_HEIGHT tiles + WebVTT)
  → subtitle extraction (mov_text → per-language .vtt)
  → master.m3u8 assembly (playlist.ts)
  → rendition rows in Postgres, asset → READY
  → Redis pub/sub progress events all the way through
```

- **Ladder** (`worker/src/ladder.ts`): 240p@400k / 480p@1000k / 720p@2500k /
  1080p@5000k / 2160p@15000k, audio 128k AAC. Rungs higher than the source
  are dropped, never upscaled.
- **Keyframe alignment** — segment duration and GOP are both
  `TRANSCODE_KEYFRAME_SECONDS` (10s default) so every rendition's segment
  boundary lines up; required for clean ABR switches and for the sprite
  timing to be exact.
- **Retries/DLQ** — BullMQ `attempts: TRANSCODE_MAX_ATTEMPTS` with
  exponential backoff; exhausted jobs land in `QUEUE_NAME_TRANSCODE_DLQ`.
  Admins requeue from the DLQ via `POST /admin/assets/:id/requeue`.
- **Progress** — the ffmpeg progress parser (`worker/src/transcode/progress.ts`)
  reads the machine-readable `-progress pipe:1` lines, maps per-rung progress
  onto the whole job, and publishes percent/stage/rung/eta over Redis
  pub/sub; the API's Socket.io layer relays it to `admin` rooms.

## Storage abstraction

`packages/storage` exposes one interface (`put/get/stat/exists/delete/
deletePrefix/…`) with two drivers: `LocalDriver` (filesystem tree, used in
compose/dev) and `S3Driver` (S3-compatible: AWS, MinIO, R2; presigned GETs
when `S3_USE_PRESIGNED_PLAYBACK=true`). The API, worker and nginx all go
through it or the paths it lays down — swapping backends is env-only, no code.

## Realtime

Socket.io with the Redis adapter: `REALTIME_EVENT_CHANNEL` /
`REALTIME_PROGRESS_CHANNEL` pub/sub. Any API replica can serve any socket;
events published by the worker arrive wherever the interested socket is
connected. Rooms: `user:<id>`, `profile:<id>`, `admin`.

## Deployment topology

- **docker-compose**: postgres · redis · api · worker · nginx. Worker mounts
  a scratch volume at `/data/work` for ffmpeg temp output. nginx terminates
  TLS, adds CORS, serves `/hls/*` straight off the volume with immutable
  cache headers and full range-request support.
- **CI** (`.github/workflows/ci.yml`): lint + typecheck + build + tests
  (API/worker/storage) on every push/PR, plus docker buildx builds of both
  images to prove the Dockerfiles. `workflow_dispatch` for on-demand runs.
- **Release** (`release-worker-exe.yml`): on `v*` tags — builds the worker
  as a single Windows exe (bun compile), packages an Inno Setup installer,
  smoke-tests **installed** exe (install → boot → uninstall-poll) and the
  packaged zip, attaches both to the GitHub release.

## Decisions worth knowing

| Decision | Why |
| --- | --- |
| One Prisma client shared by API + worker | one generated client for one schema — no drift |
| Prisma client generated into `src/` and committed | imports resolve without a build step; `copy-prisma-assets.mjs` mirrors it into `dist/` (tsc won't) |
| `--ignore-scripts` in Docker | prepare/postinstall can't run before sources exist |
| Opaque hashed refresh tokens, not JWTs | revocable server-side; rotation + reuse detection |
| HMAC-signed HLS URLs (short TTL) | zero-cost authorization on the hot segment path |
| ffmpeg as a CLI child process, not a library | keeps codec/flag control, avoids native-module packaging hell |
| Fixed 10s GOP everywhere | aligned segment boundaries across rungs |
| Redis pub/sub for progress | decouples worker replicas from socket replicas |
| Local-first storage abstraction | same code path dev→S3 without code change |
| Jest with mocked externals (Redis/Prisma/storage) | fast, hermetic; integration coverage via compose |
