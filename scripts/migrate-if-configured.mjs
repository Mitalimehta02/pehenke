// Build-time migrations for hosts without a pre-deploy command (Render free): `npm run build:render`.
//
// A deploy must never go live ahead of its database schema (seen live: builds skipped the
// migrations for two releases, and the new code ran against tables that didn't exist). So:
//   1. Use DIRECT_URL if the build environment has it.
//   2. Otherwise derive the direct connection from DATABASE_URL (a Neon pooled host is the
//      direct host plus "-pooler").
//   3. If neither is available, or `prisma migrate deploy` fails, FAIL THE BUILD. The host then
//      keeps the previous version running, which still matches the database.
// SKIP_BUILD_MIGRATIONS=1 turns this off on purpose (then run `npm run db:migrate` yourself first).
// Only variable NAMES are printed, never values.
import { spawnSync } from "node:child_process";

const has = (name) => !!process.env[name];
console.log(`[migrate] build environment: DIRECT_URL ${has("DIRECT_URL") ? "set" : "NOT set"}, DATABASE_URL ${has("DATABASE_URL") ? "set" : "NOT set"}`);

let url = process.env.DIRECT_URL;
let source = "DIRECT_URL";
if (!url && process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes("-pooler.")) {
      u.hostname = u.hostname.replace("-pooler.", ".");
      source = "DATABASE_URL (pooled host turned into the direct host)";
    } else {
      source = "DATABASE_URL";
    }
    url = u.toString();
  } catch {
    console.error("[migrate] DATABASE_URL is set but is not a valid URL.");
  }
}

if (!url) {
  if (process.env.SKIP_BUILD_MIGRATIONS === "1") {
    console.warn("[migrate] SKIP_BUILD_MIGRATIONS=1: migrations skipped on purpose. /api/health will report \"degraded\" while any are pending.");
    process.exit(0);
  }
  console.error(
    [
      "[migrate] No database connection in the build environment, so pending migrations can't be applied.",
      "[migrate] BUILD FAILED on purpose: the previous version stays live and still matches the database.",
      "[migrate] Fix: add DIRECT_URL (Neon direct connection) or DATABASE_URL to this service's environment variables.",
      "[migrate] To deploy anyway, run `npm run db:migrate` from a developer machine first and set SKIP_BUILD_MIGRATIONS=1.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`[migrate] applying pending migrations (prisma migrate deploy), connection from ${source}…`);
const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, DIRECT_URL: url } });
if (r.status !== 0) console.error("[migrate] prisma migrate deploy failed: BUILD FAILED, the previous version stays live.");
process.exit(r.status ?? 1);
