import "server-only";
import { auditorFromEnv } from "../audit";
import { createApp, type App } from "../app";
import { db } from "../db";
import { serverEnv } from "../env";
import { YouCamClient } from "../youcam";

/** One app instance per server process (reused across Next dev hot reloads). */
const g = globalThis as unknown as { pehenkeApp?: App; pehenkeBoot?: Promise<void> };

export function getApp(): App {
  if (!g.pehenkeApp) {
    const env = serverEnv();
    g.pehenkeApp = createApp({
      prisma: db(),
      youcam: (logger) => new YouCamClient({ apiKey: env.YOUCAM_API_KEY, secretKey: env.YOUCAM_SECRET_KEY, baseUrl: env.YOUCAM_BASE_URL, logger }),
      caps: { youcamDailyUnits: env.YOUCAM_DAILY_UNIT_CAP, buyerDailyRenders: env.BUYER_DAILY_RENDERS, geminiDailyLimit: env.GEMINI_DAILY_LIMIT },
      auditor: (onRequest) => auditorFromEnv(onRequest),
    });
  }
  return g.pehenkeApp;
}

const PURGE_EVERY_MS = 60 * 60_000;

/**
 * Server start: resume renders interrupted by a restart or sleep (Render may
 * stop idle servers; disk is wiped on deploy, so everything is in Postgres),
 * then run the 30-day retention purge now and hourly while awake.
 */
export function boot(): Promise<void> {
  g.pehenkeBoot ??= (async () => {
    const app = getApp();
    try {
      const r = await app.tryOns.resumeAll();
      if (r.resumed || r.abandoned) console.log(`[boot] try-ons resumed: ${r.resumed}, abandoned: ${r.abandoned}`);
    } catch (err) {
      console.error("[boot] resume failed", err);
    }
    const purge = async () => {
      try {
        const p = await app.consent.purgeExpired();
        if (p.photos) console.log(`[retention] deleted ${p.photos} photos and ${p.renders} renders of ${p.buyers} buyers (older than 30 days)`);
      } catch (err) {
        console.error("[retention] purge failed", err);
      }
    };
    await purge();
    setInterval(purge, PURGE_EVERY_MS).unref?.();
  })();
  return g.pehenkeBoot;
}
