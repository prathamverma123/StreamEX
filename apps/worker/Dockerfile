# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# StreamEX transcode worker image (multi-stage)
#   Same deps/build stages as the API; the runner adds ffmpeg + ffprobe
#   (the worker shells out to them) and boots the BullMQ consumer.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/storage/package.json packages/storage/package.json

# --ignore-scripts: the root prepare/postinstall build the storage package
# and run prisma generate — impossible before the sources are COPYed.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --workspace @streamex/worker --include-workspace-root

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/storage packages/storage
COPY apps/api apps/api
COPY apps/worker apps/worker

# The worker imports the API's generated Prisma client (src/generated for
# TS; the compiled requires resolve via dist/generated — mirrored by
# scripts/copy-prisma-assets.mjs, same as local `npm run build`).
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

RUN npm run build --workspace @streamex/storage
RUN npm run build --workspace @streamex/api
RUN npm run build --workspace @streamex/worker
RUN node scripts/copy-prisma-assets.mjs

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg/ffprobe are the worker's transcoding tools — non-negotiable.
RUN apt-get update -y && apt-get install -y --no-install-recommends \
      openssl curl ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system streamex && useradd --system --gid streamex --create-home streamex

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev --workspace @streamex/worker --include-workspace-root

COPY --from=build /app/packages/storage/dist packages/storage/dist
COPY --from=build /app/packages/storage/package.json packages/storage/package.json
# The compiled worker requires ../../api/src/generated/... at runtime
# (rootDir-relative path baked in by tsc), so the generated client must
# exist under src/generated too — not just the API's dist/generated.
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
# Runtime bits the engine needs.
COPY --from=build /app/apps/api/dist/generated apps/api/dist/generated
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/worker/dist apps/worker/dist

# Scratch dir for ffmpeg output (bind-mount or volume for large jobs).
RUN mkdir -p /data/work && chown -R streamex:streamex /data
ENV TRANSCODE_TMP_DIR=/data/work

USER streamex

# Workers are long-running consumers; no exposed ports. HEALTHCHECK: the worker
# has no HTTP surface, so probe the process tree instead.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f "node apps/worker/dist/index.js" || exit 1

CMD ["node", "apps/worker/dist/index.js"]
