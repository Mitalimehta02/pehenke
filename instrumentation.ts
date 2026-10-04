/**
 * Runs once when a Next.js server starts, before it serves requests (Next 16
 * docs: instrumentation.register). Resumes pending try-ons and starts the
 * retention purge. Node runtime only: the app uses Prisma, sharp and timers.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.YOUCAM_API_KEY || !process.env.DATABASE_URL) {
    console.warn("[boot] YOUCAM_API_KEY or DATABASE_URL missing: skipping resume and retention");
    return;
  }
  const { boot } = await import("./lib/server/app");
  await boot();
}
