import "server-only";
import { readdirSync } from "node:fs";
import path from "node:path";
import { dbAsync } from "../db";
import { summariseHealth, type HealthSummary } from "../healthSummary";

/**
 * Facts behind /api/health: required variables, database reachability and
 * pending migrations (see lib/healthSummary.ts for how they are reported).
 *
 * The database is checked at most once every DB_CHECK_EVERY_MS, plus on the
 * first call after start (i.e. after every deploy) and on every call while it
 * is not healthy: Render calls the health path every few seconds, and a query
 * each time would keep the Neon database awake around the clock. `?fresh=1`
 * forces a new check.
 */

export interface Health extends HealthSummary {
  checkedSecondsAgo: number;
  uptimeSeconds: number;
}

/** The server can't work without these. */
const REQUIRED = ["YOUCAM_API_KEY", "DATABASE_URL"] as const;
/** Features are switched off or weaker without these (reported, but not "degraded"). */
const RECOMMENDED = ["DIRECT_URL", "APP_URL", "ADMIN_SECRET"] as const;
const DB_CHECK_EVERY_MS = 60 * 60_000;
/** Render's health check gives up after 5 s. */
const DB_TIMEOUT_MS = 3500;

const local = () => process.env.LOCAL_PGLITE === "1" && process.env.NODE_ENV !== "production";
const isSet = (name: string) => !!process.env[name];

let last: { at: number; database: "ok" | "unreachable"; pending: number | null; failed: number } | undefined;
let running: Promise<void> | undefined;

function migrationNames(): string[] {
  try {
    return readdirSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "prisma", "migrations")).filter((d) => /^\d+_/.test(d));
  } catch {
    return [];
  }
}

async function checkDatabase(): Promise<void> {
  const result: NonNullable<typeof last> = { at: Date.now(), database: "unreachable", pending: null, failed: 0 };
  try {
    const prisma = await dbAsync();
    // local development keeps its own list (lib/db.ts); everywhere else it is Prisma's table
    const sql = local() ? `SELECT name, true AS ok FROM "_local_migrations"` : `SELECT migration_name AS name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS ok FROM "_prisma_migrations"`;
    const rows = await Promise.race([
      prisma.$queryRawUnsafe<Array<{ name: string; ok: boolean }>>(sql),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS)),
    ]);
    const applied = new Set(rows.filter((r) => r.ok).map((r) => r.name));
    result.database = "ok";
    result.failed = rows.filter((r) => !r.ok).length;
    result.pending = migrationNames().filter((m) => !applied.has(m)).length;
  } catch {
    result.database = "unreachable";
  }
  last = result;
}

export async function health(fresh = false): Promise<Health> {
  // local development: the in-process database needs no URL, the fake renderer needs no key
  const fake = process.env.YOUCAM_FAKE === "1" && process.env.NODE_ENV !== "production";
  const missing = REQUIRED.filter((n) => !(isSet(n) || (n === "DATABASE_URL" && local()) || (n === "YOUCAM_API_KEY" && fake)));
  const canCheckDb = !missing.includes("DATABASE_URL");
  if (canCheckDb && (fresh || !last || Date.now() - last.at > DB_CHECK_EVERY_MS || last.database !== "ok" || !!last.pending || !!last.failed)) {
    running ??= checkDatabase().finally(() => (running = undefined));
    await running;
  }
  const summary = summariseHealth({
    missing: [...missing],
    notSet: local() ? [] : RECOMMENDED.filter((n) => !isSet(n)),
    database: canCheckDb ? (last?.database ?? null) : null,
    pending: last?.pending ?? null,
    failed: last?.failed ?? 0,
  });
  return { ...summary, checkedSecondsAgo: last ? Math.round((Date.now() - last.at) / 1000) : 0, uptimeSeconds: Math.round(process.uptime()) };
}
