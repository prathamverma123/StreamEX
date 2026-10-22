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
# The root postinstall runs `prisma generate --schema=apps/api/prisma/schema.prisma`
# during npm ci — the schema must be on disk for it to succeed.
COPY apps/api/prisma apps/api/prisma

RUN --mount=type=cache,target=/root/.npm npm ci --workspace @streamex/worker --include-workspace-root

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/storage packages/storage
COPY apps/api apps/api
COPY apps/worker apps/worker

# The worker imports the API's generated Prisma client.
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

RUN npm run build --workspace @streamex/storage
RUN npm run build --workspace @streamex/api
RUN npm run build --workspace @streamex/worker

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
# Same as the deps stage: npm ci triggers the root postinstall (prisma
# generate), which needs the schema BEFORE it runs.
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @streamex/worker --include-workspace-root

COPY --from=build /app/packages/storage/dist packages/storage/dist
COPY --from=build /app/packages/storage/package.json packages/storage/package.json
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
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
