# StreamEX API Reference

Complete reference for every HTTP endpoint exposed by the StreamEX API
server (Express, TypeScript). Base URL in local development:
`http://localhost:4000`. Behind nginx (docker compose): `http://localhost:8080`.

An interactive OpenAPI/Swagger UI generated from the same routes is served at
`SWAGGER_PATH` (default `/docs`), with the raw spec at `GET /docs/openapi.json`.

---

## Conventions

### Authentication

All endpoints except `POST /auth/register`, `POST /auth/login`,
`POST /auth/refresh`, `POST /auth/forgot-password`, `POST /auth/reset-password`
and `GET /catalog/*` (public browse/search) require a bearer token:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived JWTs (default 15m). Refresh tokens are opaque
256-bit tokens stored hashed in the `sessions` table (default 30d), rotated on
every refresh. When `JWT_ACCESS_SECRET_PREVIOUS`/`JWT_REFRESH_SECRET_PREVIOUS`
are set, the previous key pair remains valid for verification during a key
rotation window.

### Profile context

Most user endpoints require the profile header:

```
X-Profile-Id: <uuid>
```

The middleware `attachProfile` verifies the profile belongs to the
authenticated user and loads the `isKids` flag used by kids-mode content
filtering. Endpoints that need it are marked **profile** below.

### Content-Type

- Requests with a body: `application/json` (limit 2 MB).
- Chunked uploads: `application/octet-stream` (see `/upload`).

### Rate limits (fixed window, Redis-backed)

| Scope | Default | Window |
| --- | --- | --- |
| Global (per IP) | 300 req | 60s |
| `/auth/login`, `/auth/register`, `/auth/forgot-password` | 10 req | 60s |
| `/auth/refresh` | 30 req | 60s |
| `/playback/*` | 60 req | 60s |

Rate-limited responses return `429` with `Retry-After`. Health endpoints
(`/health`, `/healthz`, `/ready`) are exempt.

### Error format

Every non-2xx response is a single JSON envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "human-readable summary",
    "requestId": "b7f0…",
    "details": [ … ]
  }
}
```

`details` is present only for `VALIDATION_ERROR` (one entry per invalid
field: `{ path, message }`).

#### Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request body/query failed Zod validation |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token or bad credentials |
| `TOKEN_EXPIRED` | 401 | Access token expired — client should refresh |
| `PAYMENT_REQUIRED` | 402 | Reserved |
| `FORBIDDEN` | 403 | Authenticated but not allowed (non-admin on admin route, kids profile on mature title) |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Duplicate (email already registered, title already in watchlist) |
| `GONE` | 410 | Refresh token was reused (rotation family invalidated) |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds `UPLOAD_MAX_BYTES` |
| `UNSUPPORTED_MEDIA` | 415 | Unsupported container/codec or content type |
| `RATE_LIMITED` | 429 | Rate limit exceeded (see `Retry-After`) |
| `INTERNAL` | 500 | Unexpected server error (correlated by `requestId`) |

---

## System

### `GET /health` — public

Liveness probe. No auth, no rate limit.

**Response** `200`
```json
{ "status": "ok", "service": "streamex-api", "uptime": 123.4, "timestamp": "2026-10-22T09:00:00.000Z" }
```

### `GET /ready` — public

Readiness probe: checks Postgres connectivity (`SELECT 1`). Returns `503` with
`{"status":"unavailable","reason":"database"|"redis"}` when a dependency is
down, so orchestrators should stop routing traffic.

---

## Auth — `/auth`

### `POST /auth/register` — rate limited 10/60s

Creates an account and the default (adult) profile.

**Body**
```json
{ "email": "user@example.com", "password": "Str0ng!Passw0rd", "displayName": "Alex" }
```

- `email` — valid email, lower-cased
- `password` — min 8 chars, must contain upper, lower, digit
- `displayName` — 1–40 chars

**Response** `201`
```json
{
  "user": { "id": "uuid", "email": "user@example.com", "role": "USER" },
  "profile": { "id": "uuid", "name": "Alex", "isKids": false },
  "accessToken": "…",
  "refreshToken": "…",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```
**Errors** `400` invalid input · `409 CONFLICT` email registered · `429`.

### `POST /auth/login` — rate limited 10/60s

**Body** `{ "email": "…", "password": "…" }`

**Response** `200` — same shape as register (plus the existing profile list
isn't included; call `GET /profiles`).

**Errors** `400` · `401 UNAUTHORIZED` bad credentials · `429`.

### `POST /auth/refresh` — rate limited 30/60s

Rotates the refresh token: the presented token is hashed, matched against
`sessions`, marked used, and a fresh pair is minted. Reuse of an
already-rotated token invalidates the whole session family (`410 GONE`) —
detection of refresh-token theft.

**Body** `{ "refreshToken": "…" }`

**Response** `200` `{ "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": 900 }`

**Errors** `400` · `401` unknown token · `410 GONE` reuse detected.

### `POST /auth/logout` — auth

Revokes the presented refresh token's session.

**Body** `{ "refreshToken": "…" }` → **Response** `204`

### `POST /auth/logout-all` — auth

Revokes every session for the authenticated user. → **Response** `204`

### `GET /auth/me` — auth

**Response** `200`
```json
{ "user": { "id": "uuid", "email": "…", "role": "USER", "createdAt": "…" } }
```

### `POST /auth/forgot-password` — rate limited 10/60s

Always returns `202` (never reveals whether the email exists). When the user
exists, a single-use token (24h TTL, hashed at rest) is emailed. In
`MAIL_TRANSPORT=console` deployments the message — including the token — is
printed to the server log instead.

**Body** `{ "email": "…" }` → **Response** `202 { "status": "pending" }`

### `POST /auth/reset-password` — rate limited 10/60s

**Body**
```json
{ "token": "…", "password": "NewStr0ng!Pass" }
```

On success every existing session is revoked (forces re-login everywhere).

**Response** `204` **Errors** `400` · `401` invalid/expired token · `409` same
password.

---

## Profiles — `/profiles` (all auth)

### `GET /profiles`

List the user's profiles.

**Response** `200`
```json
{ "profiles": [ { "id": "uuid", "name": "Alex", "isKids": false, "avatarUrl": null, "language": "en", "maturityRating": "R", "createdAt": "…" } ] }
```

### `POST /profiles`

**Body** `{ "name": "Kids", "isKids": true, "avatarUrl": null, "language": "en", "maturityRating": "G" }`

- Max 5 profiles per user (`409 CONFLICT` when exceeded).
- `isKids: true` forces `maturityRating` to `G`/`PG` and enables kids-mode
  content filtering for every catalog/playback call made with that profile.

**Response** `201` — the profile object.

### `GET /profiles/:id` → `200` the profile · `404`

### `PATCH /profiles/:id`

**Body** — any of `{ "name", "isKids", "avatarUrl", "language", "maturityRating" }`
→ **Response** `200` updated profile. Changing `isKids` off requires the
account password? No — re-auth is not required; the change takes effect
immediately for new requests.

### `DELETE /profiles/:id` → `204` · `404` · `409` (last remaining profile)

---

## Catalog — `/catalog`

### `GET /catalog/browse` — optional auth + profile

Paginated browse with filters. Kids profiles get an automatic
`maturityRating <= PG` + excluded-genres filter applied server-side.

**Query**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–50 | 20 | |
| `genre` | string | — | exact match on `genre` relation |
| `year` | int | — | release year |
| `yearFrom`/`yearTo` | int | — | range form |
| `rating` | enum `G,PG,PG-13,R,NC-17` | — | max allowed maturity |
| `minRating` | float 0–10 | — | IMDb-style min score |
| `sort` | `title.asc`,`title.desc`,`year.asc`,`year.desc`,`rating.desc`,`popularity.desc` | `popularity.desc` | |
| `type` | `MOVIE`,`SERIES` | — | |

**Response** `200`
```json
{
  "items": [ { "id": "uuid", "slug": "…", "title": "…", "type": "MOVIE", "posterUrl": "…", "backdropUrl": "…", "releaseYear": 2024, "maturityRating": "PG-13", "runtimeMinutes": 118, "avgRating": 7.8, "genres": ["Drama"] } ],
  "page": 1, "limit": 20, "total": 137, "totalPages": 7
}
```

### `GET /catalog/search` — optional auth + profile

Full-text search across title, tagline and description (Postgres
`tsvector`/GIN index, created by `npm run db:enhance`).

**Query** `q` (1–200 chars, required), `page`, `limit`, `type`.

**Response** `200` — same envelope as browse, ranked by ts_rank.

### `GET /catalog/genres` — public → `200 { "genres": ["Action", …] }`

### `GET /catalog/titles/:id` — optional auth + profile

Full detail: `403 FORBIDDEN` when the title's maturity exceeds a kids
profile's ceiling. Includes nested seasons/episodes for series, asset +
renditions when transcoded.

**Response** `200`
```json
{
  "id": "uuid", "title": "…", "type": "MOVIE", "description": "…",
  "maturityRating": "PG-13", "releaseYear": 2024, "runtimeMinutes": 118,
  "avgRating": 7.8, "genres": ["Drama"], "tags": ["slow-burn"],
  "posterUrl": "…", "backdropUrl": "…",
  "asset": { "id": "uuid", "status": "READY", "hlsUrl": "…", "durationSeconds": 7080 },
  "seasons": [
    { "id": "uuid", "number": 1, "episodes": [ { "id": "uuid", "number": 1, "title": "…", "runtimeMinutes": 52, "asset": { … } } ] }
  ]
}
```

### `GET /catalog/titles/:id/similar` — optional auth + profile

"Similar titles" — genre/tag overlap scoring: candidates sharing genres
(weight 2) and tags (weight 1), normalised, capped to `limit`.

**Query** `limit` (1–20, default 10) → **Response** `200 { "items": [ …titles ] }`

### `GET /catalog/hero` — optional auth + profile

One curated backdrop for the landing hero (highest-popularity READY asset,
kids-filtered). → `200 { "title": { …detail… } }` or `200 { "title": null }`.

---

## Playback — `/playback` (auth + profile)

### `POST /playback/:assetId/manifest`

Returns a **short-lived signed URL** for the master HLS manifest. The token
embeds `assetId`, `profileId`, `maxRung` (kids/rendition ceiling) and `exp`;
it is HMAC-SHA256 signed with `HLS_SIGNING_SECRET`. Token TTL:
`HLS_TOKEN_TTL_SECONDS` (default 300).

**Body** `{ "bandwidthKbps": 25000 }` *(optional)*

- When provided, the response's `renditions` list is filtered to the
  bandwidth-adaptive selection the player should start with (the rung at or
  below the reported bandwidth), and `startRenditionId` names it.
- `maxRung` for kids profiles is capped at 720p by the profile's maturity
  ceiling.

**Response** `200`
```json
{
  "manifestUrl": "https://…/hls/<token>/master.m3u8",
  "expiresAt": "2026-10-22T09:05:00.000Z",
  "renditions": [ { "id": "uuid", "label": "1080p", "width": 1920, "height": 1080, "bandwidthKbps": 5000, "codecs": "avc1.640028,mp4a.40.2" } ],
  "startRenditionId": "uuid"
}
```

**Errors** `404` asset · `403` not entitled/kids-blocked · `409 CONFLICT`
asset not `READY`.

### `GET /playback/:assetId/renditions`

Rendition list + the adaptive selection logic's computed ladder for the
profile, without minting a token. Same shape as above minus `manifestUrl`.

---

## HLS delivery — `/{HLS_SEGMENT_PREFIX}/:token/*` (default `/hls/…`)

Signed, stateless segment delivery. nginx serves these directly from the
storage volume with `Cache-Control: public, max-age=31536000, immutable`,
range-request support and CORS; the API only validates the token on the
manifest request. Segments under the token path are content-addressed — no
per-request API work.

**Errors** `401` bad/expired token · `403` token/profile mismatch.

---

## Watch progress — `/progress` (auth + profile)

### `POST /progress/heartbeat`

Debounced upsert. The route accepts pings as often as the player sends them;
writes are debounced server-side (a per-asset/profile pending write flushed
at most every 15s or on completion) so rapid pings cost one UPDATE.

**Body**
```json
{ "assetId": "uuid", "titleId": "uuid", "positionSeconds": 1234, "durationSeconds": 7080, "completed": false }
```

`completed` is auto-derived when `positionSeconds >= durationSeconds - 30`.

**Response** `200 { "ok": true, "positionSeconds": 1234, "completed": false, "resumeAt": 1234 }`

### `GET /progress/continue-watching`

Smart-sorted continue-watching: most-recent first, completed titles
excluded, `resumePositionSeconds` calculated per item (position, or
`null` when the title should restart).

**Query** `limit` (1–50, default 20) → **Response** `200`
```json
{ "items": [ { "titleId": "uuid", "assetId": "uuid", "title": "…", "posterUrl": "…", "resumePositionSeconds": 1234, "positionSeconds": 1234, "durationSeconds": 7080, "percentComplete": 17.4, "lastWatchedAt": "…" } ] }
```

### `GET /progress/titles/:titleId` → `200 { "progress": { … } }` · `404`

---

## Watchlist — `/watchlist` (auth + profile)

### `GET /watchlist?includeProgress=true` → `200 { "items": [ … ] }`

### `POST /watchlist` — **Body** `{ "titleId": "uuid" }` → `201 { …item }` · `409 CONFLICT` already present

### `DELETE /watchlist/:titleId` → `204` · `404`

### `GET /watchlist/:titleId/check` → `200 { "inWatchlist": true }`

---

## Admin — `/admin` (auth, `role=ADMIN` required; `403` otherwise)

### `POST /admin/titles/bulk`

Bulk title ingestion. `mode: "upsert"` matches on `slug` (update when found);
`mode: "insert"` skips existing rows. Entire batch in one transaction —
validation failure of any row rolls the whole upload (`400` with per-row
`details`).

**Body**
```json
{
  "mode": "upsert",
  "titles": [
    { "slug": "the-north-star", "title": "The North Star", "type": "MOVIE",
      "description": "…", "releaseYear": 2024, "maturityRating": "PG-13",
      "runtimeMinutes": 118, "genres": ["Drama"], "tags": ["slow-burn"] }
  ]
}
```

**Response** `202 { "created": 12, "updated": 3, "skipped": 0, "total": 15 }`

### `POST /admin/assets`

Registers a source video asset and enqueues a transcode job (BullMQ →
`QUEUE_NAME_TRANSCODE`).

**Body** `{ "titleId": "uuid", "sourceKey": "uploads/src/….mp4", "language": "en", "isPrimary": true }`

**Response** `202 { "asset": { … }, "jobId": "bullmq-job-id" }` · `404` title · `409` primary asset exists.

### `GET /admin/moderation?status=PENDING&page=1&limit=20`

The moderation queue — user-flagged content and auto-flagged titles pending
review.

**Response** `200 { "items": [ { "id": "uuid", "kind": "TITLE_REVIEW", "targetTitleId": "uuid", "reason": "…", "status": "PENDING", "createdAt": "…" } ], "page": 1, "total": 4, "totalPages": 1 }`

### `PATCH /admin/moderation/:id`

**Body** `{ "status": "APPROVED", "note": "cleared" }` (`status`:
`PENDING|APPROVED|REJECTED`) → **Response** `200` the updated item.

### `POST /admin/assets/:assetId/requeue`

Re-enqueues a failed/stuck asset after DLQ/retry exhaustion, resetting its
status to `QUEUED`. → **Response** `202 { "assetId": "…", "jobId": "…" }` ·
`409` asset already processing.

---

## Upload — `/upload` (auth, ADMIN required)

Resumable chunked upload for large source files (default chunk
`UPLOAD_CHUNK_SIZE`=8MB, max `UPLOAD_MAX_BYTES`=20GB).

### `POST /upload/init`

**Body** `{ "filename": "source.mp4", "sizeBytes": 1845234981, "contentType": "video/mp4", "checksum": "sha256:…" *(optional)* }`

**Response** `201`
```json
{ "uploadId": "uuid", "chunkSize": 8388608, "totalChunks": 221, "expiresAt": "…" }
```

### `PUT /upload/:id/chunks/:index`

**Body** — raw `application/octet-stream` chunk bytes (max `2 * chunkSize`).
Idempotent: re-sending a chunk is a no-op. Writes land in
`STORAGE_LOCAL_ROOT/uploads/parts/<uploadId>/<index>` (or S3 prefix).

**Response** `204` · **Errors** `404` unknown/expired id · `413` wrong size ·
`400` index out of range.

### `GET /upload/:id`

**Response** `200 { "uploadId": "…", "receivedChunks": [0,1,2], "totalChunks": 221, "sizeBytes": 1845234981, "status": "IN_PROGRESS" }`

### `POST /upload/:id/complete`

Assembles parts into `uploads/src/<uploadId>.mp4`, verifies all chunks
present (and the checksum when supplied), and returns the final storage key
to feed `POST /admin/assets`.

**Response** `200 { "uploadId": "…", "sourceKey": "uploads/src/<uuid>.mp4", "sizeBytes": 1845234981 }`
**Errors** `409 CONFLICT` missing chunks (with `details: [{ missing: [12, 44] }])`.

---

## Realtime (Socket.io)

WebSocket endpoint at `SOCKET_PATH` (default `/socket.io`). Redis pub/sub
(`REALTIME_EVENT_CHANNEL`, `REALTIME_PROGRESS_CHANNEL`) back every instance
so horizontal scaling fans out correctly.

**Auth** — client connects with `auth: { token: <accessToken> }`; the
server verifies the JWT on the handshake and joins the socket to rooms
`user:<id>` and `profile:<profileId>`.

**Admin events** (room `admin` — joined only for `role=ADMIN`):

| Event | Payload |
| --- | --- |
| `transcode:progress` | `{ assetId, percent, stage, rung, etaSeconds }` |
| `transcode:status` | `{ assetId, status, error?, attempts }` |

**User events** (rooms `profile:<id>`):

| Event | Payload |
| --- | --- |
| `progress:sync` | `{ titleId, assetId, positionSeconds, updatedAt, device }` — continue-watching sync across devices |
| `watchlist:changed` | `{ titleId, added }` |

---

## Health & ops summary

| Endpoint | Use |
| --- | --- |
| `GET /health` | liveness (no deps) |
| `GET /ready` | readiness (DB + Redis, `503` when degraded) |
| `GET /docs` | Swagger UI |
| `GET /docs/openapi.json` | machine-readable spec |
