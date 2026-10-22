# StreamEX Operations Runbook

Everything needed to run StreamEX in production: setup, deploys, monitoring,
and the incident playbook for every failure mode the system can hit.

---

## 1. Quick start (docker compose)

```bash
cp .env.example .env                # then edit secrets — see §2
docker compose up -d
docker compose exec api npm run db:migrate:deploy   # apply migrations
docker compose exec api npm run db:seed             # optional demo catalog
```

The compose stack brings up postgres, redis, api, worker and nginx. Verify:

```bash
curl http://localhost:8080/health     # {"status":"ok",...}
curl http://localhost:8080/ready      # 200 when DB+Redis reachable
open http://localhost:8080/docs       # Swagger UI
```

ffmpeg/ffprobe ship inside the worker image — nothing to install on the host.

## 2. Environment

All variables live in `.env.example` with inline comments. The ones you MUST
set for a real deployment:

| Variable | Notes |
| --- | --- |
| `POSTGRES_PASSWORD` | change from the default |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `openssl rand -hex 32` each |
| `HLS_SIGNING_SECRET` | `openssl rand -hex 32` — rotating it invalidates in-flight playback tokens (do it in a maintenance window) |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | first admin; change after first login |
| `SMTP_*` | transactional email for password reset; `MAIL_TRANSPORT=console` logs mail instead (dev only) |
| `STORAGE_BACKEND` | `local` or `s3`; with `s3` set `S3_*` |

**Key-rotation window.** Set `JWT_ACCESS_SECRET_PREVIOUS`,
`JWT_REFRESH_SECRET_PREVIOUS`, `JWT_PREVIOUS_KID` (and keep `JWT_*_KID` set)
to rotate signing keys without logging everyone out: the API signs with the
current key and verifies with current+previous for the access-token TTL
window.

## 3. Database

```bash
# migrate (prod — non-interactive)
docker compose exec api npm run db:migrate:deploy

# dev — create/apply + client regen
npm run db:migrate

# search indexes (tsvector/GIN for /catalog/search)
docker compose exec api npm run db:enhance

# demo content
docker compose exec api npm run db:seed
```

The Prisma client is generated into `apps/api/src/generated/prisma` (and
mirrored into `dist/generated` by `scripts/copy-prisma-assets.mjs` during
build). If you ever see `Cannot find module '../generated/prisma/index.js'`,
re-run `npx prisma generate --schema=apps/api/prisma/schema.prisma` then
`npm run build` — the copy script runs as part of the root build.

## 4. Deploying

### CI (every push to master)

`.github/workflows/ci.yml` runs lint + typecheck + build + the API/worker/
storage test suites, then builds both docker images with buildx to prove the
Dockerfiles. A red `build docker images` job means the image — not the code —
is broken; check which stage failed (deps/build/runner) and read §8.

### Release (tags `v*`)

`.github/workflows/release-worker-exe.yml` builds the worker as a Windows exe
(bun compile), packages the Inno Setup installer, then smoke-tests the
**installed** exe (silent install → boot with dummy env → uninstall-poll →
directory-gone check, 60s deadline) and the packaged zip. Both artifacts are
attached to the GitHub release. The uninstall poll exists because Inno's
`unins000.exe` returns before its detached copy finishes deleting — a naive
`Test-Path` right after uninstall fails spuriously.

### Deploying the API/worker images yourself

```bash
docker build -f apps/api/Dockerfile -t ghcr.io/<org>/streamex-api:v1.0.0 .
docker build -f apps/worker/Dockerfile -t ghcr.io/<org>/streamex-worker:v1.0.0 .
docker push ghcr.io/<org>/streamex-api:v1.0.0
docker push ghcr.io/<org>/streamex-worker:v1.0.0
```

The images are self-contained: generated client, compiled dist, production
node_modules. Rollback = redeploy the previous tag; migrations are
forward-only, so check the migration log before pulling a tag that adds one.

## 5. Health, monitoring, logs

| Probe | Endpoint | Expected |
| --- | --- | --- |
| Liveness | `GET /health` | `200 {"status":"ok"}` — no dependency checks, safe for restart loops |
| Readiness | `GET /ready` | `200` when Postgres+Redis reachable; `503 {"reason":"database"\|"redis"}` otherwise — stop routing traffic, don't restart |

Logs are structured JSON (pino) with `requestId` on every API line and
`jobId`/`assetId` on every worker line. Ship them anywhere that parses JSON:

```bash
docker compose logs -f api | jq 'select(.level>=40)'   # errors+
docker compose logs -f worker | jq 'select(.msg | test("transcode"))'
```

Metrics worth alerting on:

- `GET /ready` non-200 for > 1 min (dependency or app down)
- worker: `QUEUE_NAME_TRANSCODE` depth growing (transcoding can't keep up —
  scale workers: `docker compose up -d --scale worker=3`)
- worker: DLQ (`QUEUE_NAME_TRANSCODE_DLQ`) non-empty (see §7.3)
- disk: the worker scratch dir (`TRANSCODE_TMP_DIR`, `/data/work` in
  compose) and the HLS output volume fill fast — 4K sources produce tens of GB
  of segments per title

## 6. Scaling

| Component | How |
| --- | --- |
| API | replicas behind nginx; sessions are stateless (JWT + Redis rate limits), any replica serves any request |
| Worker | `--scale worker=N`; BullMQ locks (`WORKER_LOCK_DURATION_MS`) keep jobs single-owner |
| Redis | one instance is plenty for queue + pub/sub at this scale; for HA use Redis Sentinel and point `REDIS_URL` at it |
| Postgres | vertical first; the read-heavy catalog queries are covered by the GIN search index from `db:enhance` |

## 7. Incident playbook

### 7.1 API down (`/health` failing or 5xx storm)

1. `docker compose logs --tail 200 api` — look for `level: 50+` lines.
2. `docker compose ps` — is the container restarting? A crash loop with
   `Cannot find module` means a broken image build, not runtime — see §8.
3. `/ready` says `503 database`: check `docker compose logs postgres`; the
   most common cause is a migration applied by a newer tag against an older
   schema expectation — roll back the deployment.
4. Restart one replica: `docker compose restart api`. Config/env errors are
   fatal and visible in the first log lines — fix `.env` and `up -d` again.

### 7.2 Transcodes stuck (asset QUEUED/PROCESSING forever)

```bash
docker compose exec redis redis-cli llen bull:transcode:wait    # queue depth
docker compose exec redis redis-cli zcard bull:transcode:active # in-flight
docker compose logs worker | grep -i stalled
```

- Stalled jobs (worker died mid-job) auto-return to the queue after
  `QUEUE_MAX_STALLED_COUNT` / `WORKER_STALLED_INTERVAL_MS`; if the same job
  keeps stalling, the source is the problem — pull the `sourceKey` and probe
  it locally with ffprobe.
- A job in the DLQ after `TRANSCODE_MAX_ATTEMPTS`:
  `POST /admin/assets/<assetId>/requeue` (admin token) after fixing the root
  cause, or delete the asset row and re-ingest.
- ffmpeg not found / permission denied on `/data/work`: the scratch volume
  (`TRANSCODE_TMP_DIR`) must be writable by the container's `streamex` user —
  compose handles this; custom setups often forget it.

### 7.3 Playback broken

- `401` on manifest fetch right after deploy → `HLS_SIGNING_SECRET` changed;
  in-flight tokens died. It self-heals within `HLS_TOKEN_TTL_SECONDS`.
- Segments 404 through nginx but exist on disk → check the
  `HLS_SEGMENT_PREFIX` env on API and nginx config match, and that both
  containers mount the same storage volume.
- Buffering only at specific rungs → one rendition failed mid-job; check
  `video_renditions` for the asset (`SELECT label,status FROM … WHERE asset_id=…`)
  and requeue the asset.
- Everything 403 for one user → their profile is kids-mode; the 720p cap is
  by design (`profiles.is_kids`).

### 7.4 Auth storm / lockout

- Login 429s: `RATE_LIMIT_AUTH_MAX` (default 10/60s/IP). Legitimate clients
  retry after `Retry-After`; to loosen under a shared-NAT office, raise the
  bucket in `.env` and restart the API.
- Refresh returns `410 GONE`: token reuse detection fired — the whole session
  family was revoked. The user re-logs in. If it's happening to many users
  after a deploy, a load balancer is duplicating refresh requests (fix the
  client, not the server).
- Password-reset emails missing: `MAIL_TRANSPORT=console` silently logs them —
  check `SMTP_*` before assuming the mail provider is down.

### 7.5 Uploads failing

- `413` immediately: file exceeds `UPLOAD_MAX_BYTES`.
- `409` on complete with `missing: [...]`: chunks expired
  (`UPLOAD_TTL_SECONDS`) or a chunk PUT failed mid-transfer — the client
  should re-`GET /upload/:id` and re-send only the missing indexes; the
  endpoint is idempotent.
- Disk full on the API container: parts land under
  `STORAGE_LOCAL_ROOT/uploads/parts` until complete — clean expired ones
  (`UPLOAD_TTL_SECONDS` old) when space is tight.

### 7.6 Redis loss

- Queue jobs are **not** durable across Redis wipe — in-flight and queued
  transcodes vanish, assets stay stuck at their last status. Recovery:
  `SELECT id FROM video_assets WHERE status IN ('QUEUED','PROCESSING');` then
  `POST /admin/assets/<id>/requeue` each (or script it with an admin token).
- API auth keeps working (JWTs are stateless); rate limits and realtime
  pub/sub degrade until Redis returns.

## 8. Docker build failures (the two classics)

Both Dockerfiles deliberately use `npm ci --ignore-scripts` + explicit
`prisma generate` + `copy-prisma-assets.mjs`. If you change that shape:

1. **`npm error command sh -c tsc -p tsconfig.json` during `npm ci`** — a
   lifecycle script (prepare/postinstall) ran before sources existed. Keep
   `--ignore-scripts` on every `npm ci` inside the images.
2. **`Cannot find module '../generated/prisma/index.js'` at container boot** —
   the generated client never made it into `dist/`. The build stage must run
   `node scripts/copy-prisma-assets.mjs` after `npm run build --workspace
   @streamex/api`, and the runner must COPY `apps/api/dist` from the build
   stage (the worker image additionally restores `apps/api/src/generated` —
   the compiled worker's require path points there verbatim).

## 9. Backups

- **Postgres**: `docker compose exec postgres pg_dump -U streamex streamex |
  gzip > backup-$(date +%F).sql.gz` — nightly cron, retain 30 days; test
  restores quarterly.
- **Media**: with `STORAGE_BACKEND=local`, the `STORAGE_LOCAL_ROOT` volume is
  the only copy of renditions — snapshot it. With `s3`, enable bucket
  versioning + lifecycle rules instead.
- **Redis**: don't bother — see §7.6; it is a cache/queue, not a system of
  record.

## 10. Common tasks

```bash
# create an admin (after bootstrap user exists)
docker compose exec api npx tsx prisma/seed.ts   # or promote via SQL:
docker compose exec postgres psql -U streamex -c \
  "UPDATE users SET role='ADMIN' WHERE email='…';"

# re-run the CI workflow on master
gh workflow run CI --ref master        # or the Actions tab → CI → Run workflow

# see worker transcode progress live (any admin socket)
# → Socket.io admin room: transcode:progress { assetId, percent, stage, rung, etaSeconds }

# wipe the demo catalog locally
docker compose down -v && docker compose up -d   # destroys ALL data — dev only
```
