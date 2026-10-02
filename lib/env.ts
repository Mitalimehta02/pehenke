import "server-only";
import { z } from "zod";

const schema = z.object({
  YOUCAM_API_KEY: z.string().min(1, "YOUCAM_API_KEY is not set (see .env.example)"),
  YOUCAM_BASE_URL: z.url().default("https://yce-api-01.makeupar.com"),
  SPIKE_UNIT_CAP: z.coerce.number().int().positive().default(300),
  DATABASE_URL: z.string().optional(),
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
