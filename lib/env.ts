import "server-only";
import { z } from "zod";

const schema = z.object({
  YOUCAM_API_KEY: z.string().min(1, "YOUCAM_API_KEY is not set (see .env.example)"),
  /** V1 token auth only (fallback); empty counts as unset */
  YOUCAM_SECRET_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  YOUCAM_BASE_URL: z.url().default("https://yce-api-01.makeupar.com"),
  SPIKE_UNIT_CAP: z.coerce.number().int().positive().default(300),
  /** Postgres, POOLED (Neon "-pooler" host): app queries via lib/db.ts */
  DATABASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** Postgres, DIRECT (no "-pooler"): Prisma CLI / migrations only, read by prisma.config.ts */
  DIRECT_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** hard daily cap on YouCam units for the whole app (Asia/Kolkata day) */
  YOUCAM_DAILY_UNIT_CAP: z.coerce.number().int().positive().default(60),
  /** new (uncached) renders one buyer may start per day */
  BUYER_DAILY_RENDERS: z.coerce.number().int().positive().default(6),
  /** Gemini requests per day we allow ourselves (free tier allows 20) */
  GEMINI_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(18),
  /** render audit (optional): skipped cleanly when unset */
  GEMINI_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  GEMINI_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/** Parsed lazily so `next build` works without a key. Never log the result. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Only report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid server environment:\n  ${problems.join("\n  ")}`);
  }
  cached = parsed.data;
  return cached;
}
