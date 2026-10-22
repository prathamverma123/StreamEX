# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# StreamEX API server image (multi-stage)
#   1. deps     — install workspace dependencies + generate the Prisma client
#   2. build    — compile the API + storage package TypeScript
#   3. runner   — production runtime with only the JS that runs
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app

# OpenSSL for the Prisma query engine, curl for the container healthcheck.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/storage/package.json packages/storage/package.json
# The root postinstall runs `prisma generate --schema=apps/api/prisma/schema.prisma`
# during npm ci — the schema must be on disk for it to succeed.
COPY apps/api/prisma apps/api/prisma

RUN --mount=type=cache,target=/root/.npm npm ci --workspace @streamex/api --include-workspace-root

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/storage packages/storage
COPY apps/api apps/api

# Prisma client generates into apps/api/src/generated — needed for the API's
# imports and for the worker's shared-client import to typecheck.
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# Build the shared storage package first (the API imports @streamex/storage).
RUN npm run build --workspace @streamex/storage
RUN npm run build --workspace @streamex/api

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN groupadd --system streamex && useradd --system --gid streamex --create-home streamex

# Production dependencies only (postinstall regenerates the Prisma client).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/storage/package.json packages/storage/package.json
# Same as the deps stage: npm ci triggers the root postinstall (prisma
# generate), which needs the schema BEFORE it runs.
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @streamex/api --include-workspace-root

# The storage package is a workspace dep — restore its built output.
COPY --from=build /app/packages/storage/dist packages/storage/dist
COPY --from=build /app/packages/storage/package.json packages/storage/package.json
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma

USER streamex
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
