import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../generated/prisma/client";

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");

/**
 * A fresh in-process Postgres (PGlite) with the real migrations applied, and a
 * Prisma client on it. Tests run the actual schema and queries with no
 * network (the developer's network blocks port 5432).
 */
export async function createTestDb(): Promise<{ prisma: PrismaClient; close: () => Promise<void> }> {
  const pg = new PGlite();
  for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort()) {
    await pg.exec(readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await pg.close();
    },
  };
}
