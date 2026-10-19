/**
 * Release packaging for the compiled Windows worker.
 *
 * Assembles a self-contained distribution folder:
 *
 *   release/streamex-worker-win-x64/
 *     streamex-worker.exe             — Bun-compiled worker binary
 *     query_engine-windows.dll.node   — Prisma native query engine
 *     README.txt                      — setup + run instructions
 *     .env.example                    — every required variable
 *     bin/                            — (optional) ffmpeg/ffprobe drop-in
 *
 * …then zips it to release/streamex-worker-win-x64.zip.
 *
 * Usage:
 *   node scripts/package.mjs            (from apps/worker)
 *   node apps/worker/scripts/package.mjs  (from repo root)
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '..');
const repoRoot = resolve(workerDir, '..', '..');
const outDir = join(workerDir, 'release');
const distName = 'streamex-worker-win-x64';
const distDir = join(outDir, distName);
const exePath = join(workerDir, 'dist-exe', 'streamex-worker.exe');
const engineInRepo = join(
  repoRoot,
  'apps',
  'api',
  'src',
  'generated',
  'prisma',
  'query_engine-windows.dll.node',
);
const engineInNodeModules = join(
  repoRoot,
  'node_modules',
  '@prisma',
  'engines',
  'libquery_engine-windows-dll.node',
);

const README = `StreamEX Transcode Worker (Windows x64)
=====================================

WHAT THIS IS
------------
A single-binary transcode worker for the StreamEX platform. It consumes
transcode jobs from Redis (BullMQ), runs ffmpeg to produce multi-bitrate
HLS, thumbnails and WebVTT subtitles, and writes progress back to
Postgres.

WHAT YOU NEED
-------------
1. A reachable PostgreSQL database (the StreamEX schema applied).
2. A reachable Redis instance (job queue + pub/sub).
3. ffmpeg + ffprobe somewhere on PATH — OR drop them into the "bin"
   folder next to this exe (bin\\ffmpeg.exe, bin\\ffprobe.exe).
4. (Windows) The Visual C++ Redistributable for Visual Studio 2015-2022,
   required by the bundled Prisma query engine.

RUNNING
-------
1. Copy .env.example to .env next to the exe and fill in DATABASE_URL
   and REDIS_URL (plus storage settings if not using local storage).
2. Start the worker:

     streamex-worker.exe

   It logs JSON to stdout. Set LOG_PRETTY=false for machine-readable logs.

3. To enqueue a job, either use the StreamEX API or push directly:

     redis-cli> LPUSH ... (use the API's admin endpoints instead)

WORKER BEHAVIOUR
----------------
- Concurrency is set by TRANSCODE_CONCURRENCY (default 2).
- Failed jobs are retried up to TRANSCODE_MAX_ATTEMPTS (default 3) with
  exponential backoff, then moved to the dead-letter queue
  (${'{'}transcode:dlq${'}'}).
- The worker never exits on a bad job; it only exits when it cannot reach
  Redis or the database at startup.

FILES
-----
streamex-worker.exe              The worker binary
query_engine-windows.dll.node    Prisma's native query engine (required)
.env.example                     Template for configuration
bin\\                             Optional ffmpeg/ffprobe drop-in folder
`;

async function main() {
  // 0. Preflight: the exe must exist.
  if (!existsSync(exePath)) {
    console.error(
      `[package] missing ${exePath} — run "bun run build:exe" (or npm run build:exe) first`,
    );
    process.exit(1);
  }

  // 1. Locate the Prisma query engine.
  let engineSource = existsSync(engineInRepo) ? engineInRepo : null;
  if (!engineSource && existsSync(engineInNodeModules)) engineSource = engineInNodeModules;
  if (!engineSource) {
    console.error(
      '[package] Prisma query engine not found — run "prisma generate --schema=apps/api/prisma/schema.prisma" first',
    );
    process.exit(1);
  }

  // 2. Fresh dist folder.
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(join(distDir, 'bin'), { recursive: true });

  // 3. Copy artifacts.
  await cp(exePath, join(distDir, 'streamex-worker.exe'));
  await cp(engineSource, join(distDir, 'query_engine-windows.dll.node'));
  await writeFile(join(distDir, 'README.txt'), README, 'utf8');

  // .env.example — reuse the repo's, it documents every variable.
  const envExample = join(repoRoot, '.env.example');
  if (existsSync(envExample)) {
    await cp(envExample, join(distDir, '.env.example'));
  }

  // 4. Optional ffmpeg drop-in: if ffmpeg is on PATH here, ship it.
  const ffmpegOnPath = await which('ffmpeg.exe').catch(() => null);
  if (ffmpegOnPath) {
    await cp(ffmpegOnPath, join(distDir, 'bin', 'ffmpeg.exe'));
    const ffprobe = await which('ffprobe.exe').catch(() => null);
    if (ffprobe) await cp(ffprobe, join(distDir, 'bin', 'ffprobe.exe'));
    console.log(`[package] bundled ffmpeg from ${ffmpegOnPath}`);
  } else {
    console.log('[package] ffmpeg not on PATH — shipping without it (README explains)');
  }

  // 5. Write scripts/installer/version.iss from apps/worker/package.json so
  //    the Inno Setup build never drifts from the app version.
  const workerPkg = JSON.parse(
    readFileSync(join(workerDir, 'package.json'), 'utf8'),
  );
  const appVersion = String(workerPkg.version || '1.0.0');
  const installerDir = join(repoRoot, 'scripts', 'installer');
  await mkdir(installerDir, { recursive: true });
  await writeFile(
    join(installerDir, 'version.iss'),
    `#define AppVersion "${appVersion}"\n`,
    'utf8',
  );
  console.log(`[package] version.iss → AppVersion=${appVersion}`);

  // 5. Zip it. On Windows use PowerShell's Compress-Archive (no npm
  //    dependency); on Linux CI fall back to `zip -r`.
  const zipPath = join(outDir, `${distName}.zip`);
  await rm(zipPath, { force: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${distDir.replace(/'/g, "''")}/*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('zip', ['-r', '-q', zipPath, distName], { cwd: outDir, stdio: 'inherit' });
  }
  const { stat: statFile } = await import('node:fs/promises');
  const zipStat = await statFile(zipPath);
  console.log(`[package] wrote ${relative(repoRoot, zipPath)} (${(zipStat.size / 1024 / 1024).toFixed(1)} MB)`);

  // 6. Build the Inno Setup installer (additive — the zip stays the
  //    portable artifact). ISCC is resolved from: PATH, the user-profile
  //    install, or the machine install.
  const iscc = findIscc();
  if (iscc) {
    // The .iss reads dist-exe/staging — mirror the zip layout there.
    const staging = join(repoRoot, 'dist-exe', 'staging');
    await rm(staging, { recursive: true, force: true });
    await cp(distDir, staging, { recursive: true });
    console.log(`[package] staged installer input → ${relative(repoRoot, staging)}`);

    console.log('[package] compiling Inno Setup installer…');
    execFileSync(iscc, [join(repoRoot, 'scripts', 'installer', 'streamex-worker.iss')], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    const setupExe = join(repoRoot, 'dist-exe', `StreamEXWorker-Setup-${appVersion}.exe`);
    const setupStat = await statFile(setupExe);
    console.log(
      `[package] wrote ${relative(repoRoot, setupExe)} (${(setupStat.size / 1024 / 1024).toFixed(1)} MB)`,
    );
  } else {
    console.log(
      '[package] ISCC.exe not found — skipping the installer (zip-only release). ' +
        'Install Inno Setup 6 to emit StreamEXWorker-Setup-<version>.exe.',
    );
  }
}

function relative(from, to) {
  return to.startsWith(from) ? to.slice(from.length + 1) : to;
}

/** Locate ISCC.exe: PATH → user-profile install → machine install. */
function findIscc() {
  const candidates = [
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe')
      : null,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter((p) => typeof p === 'string');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const out = execFileSync('where', ['iscc'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const first = out.split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {
    // not on PATH
  }
  return null;
}

async function which(bin) {
  return new Promise((res, rej) => {
    try {
      const out = execFileSync('where', [bin], { encoding: 'utf8' });
      const first = out.split(/\r?\n/)[0].trim();
      if (first) return res(first);
      rej(new Error('not found'));
    } catch {
      rej(new Error('not found'));
    }
  });
}

main().catch((err) => {
  console.error('[package] failed:', err);
  process.exit(1);
});
