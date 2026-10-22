/**
 * Copy the generated Prisma client's runtime bits into each compiled app's
 * dist/ tree.
 *
 * Why: the API imports the client from `../generated/prisma/index.js`. tsc
 * compiles that require into `dist/lib/prisma.js` as
 * `require("../generated/prisma/index.js")` — resolved inside `dist/`, not
 * `src/`. tsc emits only the .js/.d.ts of TS files; the generated client
 * (JS + the native query engine) is not TS, so nothing copies it. The
 * runtime require therefore fails with "Cannot find module" unless the
 * generated output exists at dist/generated/prisma.
 *
 * Docker builds do this inline (see apps/api/Dockerfile); this script gives
 * local `npm run build` the identical result.
 *
 * It also regenerates the client directly into dist when missing, so a
 * fresh clone with only `npm ci --ignore-scripts` can still run `npm run
 * build` + `node dist/server.js` end to end.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const apiRoot = join(repoRoot, 'apps', 'api');
const srcGen = join(apiRoot, 'src', 'generated', 'prisma');
const distGen = join(apiRoot, 'dist', 'generated', 'prisma');
const schema = join(apiRoot, 'prisma', 'schema.prisma');

async function main() {
  if (!existsSync(srcGen)) {
    console.log('[copy-prisma-assets] src/generated missing — generating…');
    execFileSync('npx', ['prisma', 'generate', `--schema=${schema}`], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  // Fresh destination: stale engine binaries are large; avoid double copies.
  await rm(distGen, { recursive: true, force: true });
  await mkdir(distGen, { recursive: true });

  // Copy everything except source maps / declaration files the runtime
  // never loads (keeps images lean).
  await cp(srcGen, distGen, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith('.map')) return false;
      const base = src.split(/[\\/]/).pop();
      return !base?.endsWith('.d.ts');
    },
  });

  console.log('[copy-prisma-assets] apps/api/dist/generated/prisma populated');
}

main().catch((err) => {
  console.error('[copy-prisma-assets] failed:', err);
  process.exit(1);
});
