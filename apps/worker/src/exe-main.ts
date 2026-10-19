/**
 * Worker entrypoint wrapper for the compiled Windows executable.
 *
 * Bun's `--compile` produces a single streamex-worker.exe. Everything the
 * worker needs that CANNOT be embedded (the 20MB native Prisma query
 * engine, ffmpeg/ffprobe binaries) must live next to the exe, so this
 * entry:
 *
 *   1. locates its own directory (works for bare exe and zip layouts),
 *   2. sets PRISMA_QUERY_ENGINE_LIBRARY to the sibling engine file,
 *   3. adds the bin directory to PATH so ffmpeg/ffprobe resolve,
 *   4. defers to the real worker main (src/index.ts).
 *
 * Env vars (DATABASE_URL, REDIS_URL, storage settings) are read from the
 * process environment / an .env file next to the exe as usual.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

function exeDir(): string {
  // Bun compile: the target dir sits beside the exe.
  const fromTarget = process.execPath;
  if (fromTarget && existsSync(fromTarget)) {
    return dirnameOf(fromTarget);
  }
  return process.cwd();
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx === -1 ? '.' : p.slice(0, idx);
}

const dir = exeDir();

// 1. Prisma native query engine: prefer the sibling file, fall back to the
//    repo checkout's generated client (dev machines).
const candidates = [
  join(dir, 'query_engine-windows.dll.node'),
  join(dir, 'engines', 'query_engine-windows.dll.node'),
  join(dir, '..', 'apps', 'api', 'src', 'generated', 'prisma', 'query_engine-windows.dll.node'),
];

for (const candidate of candidates) {
  if (!process.env.PRISMA_QUERY_ENGINE_LIBRARY && existsSync(candidate)) {
    process.env.PRISMA_QUERY_ENGINE_LIBRARY = candidate;
    break;
  }
}

// 2. ffmpeg/ffprobe on PATH: add the bin directory shipped in the zip.
const binDir = join(dir, 'bin');
if (existsSync(binDir)) {
  const isWindows = process.platform === 'win32';
  process.env.PATH = `${binDir}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`;
}

// 3. Hand off to the real worker main.
import('./index.js');
