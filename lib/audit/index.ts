import "server-only";
import { serverEnv } from "../env";
import { GeminiAuditor } from "./gemini";
import type { RenderAuditor } from "./types";

export * from "./types";

/**
 * The configured render auditor, or undefined when no provider key is set:
 * callers must skip the audit cleanly in that case. Swap providers here.
 */
export function auditorFromEnv(): RenderAuditor | undefined {
  const env = serverEnv();
  if (!env.GEMINI_API_KEY) return undefined;
  return new GeminiAuditor({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
}
