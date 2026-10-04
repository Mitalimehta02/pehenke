import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { serverEnv } from "./env";
import { PrismaClient } from "./generated/prisma/client";

/**
 * App database client. Prisma 7 requires a driver adapter; app queries use the
 * POOLED connection (DATABASE_URL, Neon "-pooler" host). Migrations use the
 * direct connection configured in prisma.config.ts, never this client.
 *
 * Local development only: LOCAL_PGLITE=1 uses a file-backed in-process Postgres
 * (./.pglite, real migrations applied) for networks that block port 5432.
 * Ignored in production.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

async function localClient(): Promise<PrismaClient> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { PGlite } = await import("@electric-sql/pglite");
  const { PrismaPGlite } = await import("pglite-prisma-adapter");
  const pg = new PGlite(path.join(process.cwd(), ".pglite"));
  const applied = await pg.query<{ exists: boolean }>(`SELECT to_regclass('public."Seller"') IS NOT NULL AS exists`);
  if (!applied.rows[0]?.exists) {
    const dir = path.join(process.cwd(), "prisma", "migrations");
    for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) await pg.exec(readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
  }
  return new PrismaClient({ adapter: new PrismaPGlite(pg) });
}

let localPromise: Promise<PrismaClient> | undefined;

function isLocalMode() {
  return process.env.LOCAL_PGLITE === "1" && process.env.NODE_ENV !== "production";
}

function createClient(): PrismaClient {
  const url = serverEnv().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** One client per process (reused across Next dev hot reloads). */
export function db(): PrismaClient {
  if (isLocalMode()) throw new Error("LOCAL_PGLITE is on: use dbAsync()");
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}

/** Works in both modes; prefer this where an await is possible. */
export async function dbAsync(): Promise<PrismaClient> {
  if (isLocalMode()) {
    localPromise ??= localClient();
    globalForPrisma.prisma ??= await localPromise;
    return globalForPrisma.prisma;
  }
  return db();
}
