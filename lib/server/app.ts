import "server-only";
import { auditorFromEnv } from "../audit";
import { createApp, type App } from "../app";
import { dbAsync } from "../db";
import { appUrl, serverEnv } from "../env";
import type { FakeYouCam } from "../testing/fakeYoucam";
import { YouCamClient, type CallLogger } from "../youcam";

/** One app instance per server process (reused across Next dev hot reloads). */
const g = globalThis as unknown as { pehenkeApp?: Promise<App>; pehenkeBoot?: Promise<void>; pehenkeFake?: FakeYouCam };

/** Local development only: YOUCAM_FAKE=1 renders with the in-memory fake (no units). Ignored in production. */
async function youcamFactory(): Promise<(logger: CallLogger) => YouCamClient> {
  const env = serverEnv();
  if (process.env.YOUCAM_FAKE === "1" && process.env.NODE_ENV !== "production") {
    // dev-only modules, loaded lazily so they never reach the production server bundle
    const { FakeYouCam } = await import("../testing/fakeYoucam");
    const { spikeRenderLookup } = await import("../testing/devRenders");
    g.pehenkeFake ??= new FakeYouCam({ runningPolls: 3, renderFrom: await spikeRenderLookup() });
    console.warn("[dev] YOUCAM_FAKE=1: try-ons use the fake renderer, no units spent");
    return (logger) => {
      const c = g.pehenkeFake!.client(logger);
      // pace the fake like the real API so the "working" state is visible
      (c.http as unknown as { sleep: (ms: number) => Promise<void> }).sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1500)));
      return c;
    };
  }
  return (logger) => new YouCamClient({ apiKey: env.YOUCAM_API_KEY, secretKey: env.YOUCAM_SECRET_KEY, baseUrl: env.YOUCAM_BASE_URL, logger });
}

export function getApp(): Promise<App> {
  g.pehenkeApp ??= (async () => {
    const env = serverEnv();
    return createApp({
      prisma: await dbAsync(),
      youcam: await youcamFactory(),
      baseUrl: appUrl(),
      caps: { youcamDailyUnits: env.YOUCAM_DAILY_UNIT_CAP, buyerDailyRenders: env.BUYER_DAILY_RENDERS, buyerDailyLooks: env.BUYER_DAILY_LOOKS, geminiDailyLimit: env.GEMINI_DAILY_LIMIT },
      auditor: (onRequest) => auditorFromEnv(onRequest),
    });
  })();
  return g.pehenkeApp;
}

const PURGE_EVERY_MS = 60 * 60_000;
let lastPurgeAt = 0;
let purging: Promise<void> | null = null;

/**
 * Run the 30-day retention purge if it hasn't run in the last hour. Called on
 * boot, hourly while awake, and by /api/health (the keep-awake ping), so the
 * 30-day promise holds even on a host that sleeps when idle.
 */
export function maybePurge(): Promise<void> {
  if (purging || Date.now() - lastPurgeAt < PURGE_EVERY_MS) return purging ?? Promise.resolve();
  purging = (async () => {
    try {
      const app = await getApp();
      const p = await app.consent.purgeExpired();
      const votes = await app.family.purgeExpired();
      lastPurgeAt = Date.now();
      if (p.photos) console.log(`[retention] deleted ${p.photos} photos and ${p.renders} renders of ${p.buyers} buyers (older than 30 days)`);
      if (p.orders) console.log(`[retention] cleared WhatsApp numbers / card links on ${p.orders} orders (older than 30 days)`);
      if (votes) console.log(`[retention] deleted ${votes} expired family vote links`);
    } catch (err) {
      console.error("[retention] purge failed", err);
    } finally {
      purging = null;
    }
  })();
  return purging;
}

/**
 * Server start: resume renders interrupted by a restart or sleep (Render may
 * stop idle servers; disk is wiped on deploy, so everything is in Postgres),
 * then run the 30-day retention purge now and hourly while awake.
 */
export function boot(): Promise<void> {
  g.pehenkeBoot ??= (async () => {
    const app = await getApp();
    try {
      const r = await app.tryOns.resumeAll();
      if (r.resumed || r.abandoned) console.log(`[boot] try-ons resumed: ${r.resumed}, abandoned: ${r.abandoned}`);
      const looks = await app.looks.resumeAll();
      if (looks) console.log(`[boot] looks resumed: ${looks}`);
    } catch (err) {
      console.error("[boot] resume failed", err);
    }
    await maybePurge();
    setInterval(() => void maybePurge(), PURGE_EVERY_MS).unref?.();
  })();
  return g.pehenkeBoot;
}
