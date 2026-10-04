import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { serverEnv } from "./env";
import { PrismaClient } from "./generated/prisma/client";

/**
 * App database client. Prisma 7 requires a driver adapter; app queries use the
 * POOLED connection (DATABASE_URL, Neon "-pooler" host). Migrations use the
 * direct connection configured in prisma.config.ts, never this client.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = serverEnv().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** One client per process (reused across Next dev hot reloads). */
export function db(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}
