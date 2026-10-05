// Build-time migration for hosts without a pre-deploy command (Render free).
// Runs `prisma migrate deploy` when DIRECT_URL is available at build time and fails the
// build if the migration fails. If DIRECT_URL isn't available at build time, it says so
// and continues: then run `npm run db:migrate` yourself before using the new deploy.
import { spawnSync } from "node:child_process";

if (!process.env.DIRECT_URL) {
  console.warn("[migrate] DIRECT_URL is not set at build time: migrations SKIPPED. Run `npm run db:migrate` manually.");
  process.exit(0);
}
console.log("[migrate] applying pending migrations (prisma migrate deploy)…");
const r = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
