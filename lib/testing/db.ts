import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { PrismaClient } from "../generated/prisma/client";

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");

/**
 * A fresh in-process Postgres (PGlite) with the real migrations applied, and a
 * Prisma client on it. Tests run the actual schema and queries with no
 * network (the developer's network blocks port 5432).
 */
export async function createTestDb(): Promise<{ prisma: PrismaClient; reset: () => Promise<void>; close: () => Promise<void> }> {
  const pg = new PGlite();
  for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort()) {
    await pg.exec(readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  const tables = (await pg.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => `"${r.tablename}"`);
  return {
    prisma,
    /** empty every table (much faster than a new database per test) */
    reset: async () => {
      await pg.exec(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    },
    close: async () => {
      await prisma.$disconnect();
      await pg.close();
    },
  };
}

/**
 * Vitest helper: one database per test file, emptied before each test.
 * Call at the top of a test file; read `.prisma` inside tests.
 */
export function setupTestDb() {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);
  beforeEach(async () => db.reset());
  afterAll(async () => db?.close());
  return {
    get prisma() {
      return db.prisma;
    },
  };
}
