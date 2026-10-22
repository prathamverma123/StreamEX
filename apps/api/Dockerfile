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

# --ignore-scripts: the root prepare/postinstall build the storage package
# and run prisma generate — impossible before the sources are COPYed. All
# generation happens explicitly in the build stage below.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --workspace @streamex/api --include-workspace-root

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY scripts/copy-prisma-assets.mjs scripts/copy-prisma-assets.mjs
COPY packages/storage packages/storage
COPY apps/api apps/api

# Generate the Prisma client into src/generated — the TS imports and the
# compiled requires under dist/ both resolve against the generated output
# (tsc does not copy non-TS assets, so scripts/copy-prisma-assets.mjs mirrors
# it into dist/generated after the build — same as the local `npm run build`).
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# Build the shared storage package first (the API imports @streamex/storage).
RUN npm run build --workspace @streamex/storage
RUN npm run build --workspace @streamex/api
RUN node scripts/copy-prisma-assets.mjs

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN groupadd --system streamex && useradd --system --gid streamex --create-home streamex

# Production dependencies only. --ignore-scripts: the root prepare/postinstall
# would try to build the storage package and run prisma generate before any
# source exists; both are handled explicitly in the build stage.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev --workspace @streamex/api --include-workspace-root

# The storage package is a workspace dep — restore its built output.
COPY --from=build /app/packages/storage/dist packages/storage/dist
COPY --from=build /app/packages/storage/package.json packages/storage/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma

USER streamex
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
