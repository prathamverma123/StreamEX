import { PrismaClient } from '../../api/src/generated/prisma/index.js';

/**
 * The worker shares the API's generated Prisma client (the schema lives in
 * apps/api/prisma). Importing '@prisma/client' would resolve to the
 * placeholder stub npm ships when no generate has run in the right place —
 * and the workspace has the real client at the path below. This mirrors
 * apps/api/src/lib/prisma.ts.
 */

declare global {
  // eslint-disable-next-line no-var
  var __streamexWorkerPrisma: PrismaClient | undefined;
}

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (prisma) return prisma;
  prisma =
    global.__streamexWorkerPrisma ??
    new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  if (process.env.NODE_ENV !== 'production') {
    global.__streamexWorkerPrisma = prisma;
  }
  return prisma;
}

export async function resetPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
  }
  prisma = undefined;
  global.__streamexWorkerPrisma = undefined;
}

/** Test helper — inject a mock client. */
export function setPrismaForTests(client: PrismaClient | undefined): void {
  prisma = client;
  global.__streamexWorkerPrisma = client;
}
