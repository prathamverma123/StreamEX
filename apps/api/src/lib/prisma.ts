import { PrismaClient } from '../generated/prisma/index.js';

/**
 * Prisma client singleton.
 *
 * One client per process; in dev `tsx watch` restarts would otherwise leak
 * connections, so we reuse the global symbol trick.
 */

declare global {
  var __streamexPrisma: PrismaClient | undefined;
}

export type { PrismaClient } from '../generated/prisma/index.js';
export * from '../generated/prisma/index.js';

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (prisma) return prisma;
  prisma =
    global.__streamexPrisma ??
    new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  if (process.env.NODE_ENV !== 'production') {
    global.__streamexPrisma = prisma;
  }
  return prisma;
}

/** Test helper — inject a mock client. */
export function setPrismaForTests(client: PrismaClient | undefined): void {
  prisma = client;
  global.__streamexPrisma = client;
}

/** Reset the singleton (used by graceful shutdown + between test files). */
export async function resetPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
  }
  prisma = undefined;
  global.__streamexPrisma = undefined;
}
