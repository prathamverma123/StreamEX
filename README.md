# StreamEX

Production-grade streaming platform backend: Express + Prisma API, BullMQ
transcoding worker, Socket.io realtime layer, and the full deployment stack.

## Layout

```
apps/api        Express + TypeScript + Prisma REST API (catalog, playback,
                auth, watchlists, admin ingestion, OpenAPI)
apps/worker     BullMQ transcode worker — ffmpeg HLS ladder, thumbnails,
                subtitles, progress reporting
packages/storage Storage abstraction — local FS or S3-compatible behind one
                interface, selected by STORAGE_BACKEND
scripts/installer  Inno Setup installer definition for the Windows worker exe
deploy/         nginx config (HLS-optimized headers, range requests, brotli)
docs/           API reference, architecture decisions, ops runbook
```

## Quick start

```bash
npm install                # also runs prisma generate (postinstall)
docker compose up -d postgres redis   # infra only
npm run db:migrate         # apply the Prisma migration
npm run db:enhance         # create FULLTEXT/GIN indexes (tsvector etc.)
npm run db:seed            # sample titles, profiles, assets
npm run dev                # API on :4000 + worker via tsx watch
```

`.env.example` documents every variable. Secrets (JWT, HLS signing) must be
at least 32 chars — the config schema enforces it at boot.

## Tests

```bash
npm test                   # storage + API + worker (worker runs --runInBand)
npm run test:coverage      # coverage gates: 80% branches/functions/lines
```

The API suite mocks Prisma/Redis/storage; no live services needed. The
worker suite mocks execFile/child_process; no ffmpeg needed.

## Docker

```bash
docker compose up -d --build
docker compose run --rm api npm run db:migrate:deploy
docker compose run --rm api npm run db:seed
# nginx serves the API on http://localhost:8080
```

## Windows worker executable

The transcode worker can be packaged as a single-file Windows binary (Bun
`--compile`) plus the native Prisma engine beside it.

```bash
# from repo root
npm run package:installer
```

That single command:

1. compiles `apps/worker/src/exe-main.ts` → `streamex-worker.exe` (Bun,
   `bun-windows-x64` target)
2. stages `release/streamex-worker-win-x64/` — exe, `query_engine-windows.dll.node`,
   `README.txt`, `.env.example`, optional `bin/` with ffmpeg
3. writes `scripts/installer/version.iss` from `apps/worker/package.json`
   (`#define AppVersion "1.0.0"`)
4. zips the staging dir → `apps/worker/release/streamex-worker-win-x64.zip`
5. runs Inno Setup (`ISCC.exe`) → **`dist-exe/StreamEXWorker-Setup-<version>.exe`**

### Prerequisites (build machine)

- Bun (`npm i -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`) —
  `build:exe` needs it
- Inno Setup 6 — the packaging script auto-detects `ISCC.exe` from PATH,
  `%LOCALAPPDATA%\Programs\Inno Setup 6`, or `C:\Program Files (x86)\Inno Setup 6`.
  Without it the chain still emits the portable zip and skips the installer.
- The Prisma client generated (`npm install` does this via postinstall) —
  the engine DLL is copied from `apps/api/src/generated/prisma/`.

### Artifacts

| Artifact | Path |
| --- | --- |
| Portable zip | `apps/worker/release/streamex-worker-win-x64.zip` |
| Installer | `dist-exe/StreamEXWorker-Setup-<version>.exe` |
| Bare exe | `apps/worker/dist-exe/streamex-worker.exe` |

### Silent install / uninstall (CI, smoke tests)

```
StreamEXWorker-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=C:\path\to\dir
unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Silent mode skips the post-install "Launch" checkbox automatically. The
installer requires elevation (`PrivilegesRequired=admin`); right-click →
Run as administrator, or accept the UAC prompt.

### What the installer does

- Installs exe + `query_engine-windows.dll.node` + README + `.env.example`
  into `{autopf}\StreamEX Worker`, plus a `bin\` folder for optional
  ffmpeg/ffprobe drop-ins (the exe prepends it to PATH).
- Start-menu group with worker + documentation + uninstall shortcuts;
  optional desktop icon.
- Post-install checkbox "Launch StreamEX Worker".
- Checks for the MSVC VC++ 2015–2022 x64 runtime (required by the Prisma
  engine) and points to `https://aka.ms/vs/17/release/vc_redist.x64.exe`
  when missing.
- Uninstall removes program files, shortcuts, scratch dirs (`work`, `logs`,
  `bin`, `storage` after confirmation) but **never** your `.env`.

### Post-install for end users

1. Open the install folder (default `C:\Program Files\StreamEX Worker`).
2. Copy `.env.example` → `.env` and set at minimum:
   `DATABASE_URL`, `REDIS_URL`, `STORAGE_BACKEND`, `STORAGE_LOCAL_ROOT`,
   `CDN_BASE_URL`, `TRANSCODE_TMP_DIR`.
3. Ensure ffmpeg + ffprobe are on PATH, or drop `ffmpeg.exe`/`ffprobe.exe`
   into the `bin\` folder.
4. Launch "StreamEX Worker" from the Start menu. It logs JSON to stdout;
   set `LOG_PRETTY=true` for human-readable output.

The exe reads real environment variables; `.env` beside it is a convenience
loaded by the worker's dotenv config. The installer deliberately does NOT
create `.env` — that stays a manual copy so secrets are never silently
generated.

## CI / Release

- `.github/workflows/ci.yml` — lint + typecheck + tests + docker builds on
  push/PR.
- `.github/workflows/release-worker-exe.yml` — on `v*` tags (or manual
  dispatch): builds the exe on `windows-latest`, packages, smoke-tests the
  installed binary, and attaches the zip to a GitHub release.

```bash
git tag v1.0.0 && git push origin v1.0.0   # triggers the release workflow
```
