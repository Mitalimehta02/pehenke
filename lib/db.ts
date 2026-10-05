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
  const pg = new PGlite(path.join(/*turbopackIgnore: true*/ process.cwd(), ".pglite"));
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "prisma", "migrations");
  const all = readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort();
  // Applied migrations are tracked in _local_migrations. A database from before the
  // tracking table existed has exactly the first (init) migration.
  const tracked = await pg.query<{ exists: boolean }>(`SELECT to_regclass('public."_local_migrations"') IS NOT NULL AS exists`);
  if (!tracked.rows[0]?.exists) {
    const hasInit = await pg.query<{ exists: boolean }>(`SELECT to_regclass('public."Seller"') IS NOT NULL AS exists`);
    await pg.exec(`CREATE TABLE "_local_migrations" (name TEXT PRIMARY KEY)`);
    if (hasInit.rows[0]?.exists) await pg.query(`INSERT INTO "_local_migrations" (name) VALUES ($1)`, [all[0]]);
  }
  const done = new Set((await pg.query<{ name: string }>(`SELECT name FROM "_local_migrations"`)).rows.map((r) => r.name));
  for (const m of all.filter((m) => !done.has(m))) {
    await pg.exec(readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
    await pg.query(`INSERT INTO "_local_migrations" (name) VALUES ($1)`, [m]);
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
