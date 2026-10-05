/**
 * Runs once when a Next.js server starts, before it serves requests (Next 16
 * docs: instrumentation.register). Starts resuming pending try-ons and the
 * retention purge in the background: register() must finish before the first
 * request, and on a host that sleeps when idle every wake-up is a cold start,
 * so it must not wait for that work. Node runtime only (Prisma, sharp, timers).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.YOUCAM_API_KEY || (!process.env.DATABASE_URL && process.env.LOCAL_PGLITE !== "1")) {
    console.warn("[boot] YOUCAM_API_KEY or DATABASE_URL missing: skipping resume and retention");
    return;
  }
  const { boot } = await import("./lib/server/app");
  void boot().catch((err) => console.error("[boot] failed", err));
}
