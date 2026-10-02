import "server-only";
import { serverEnv } from "../env";
import { YouCamClient } from "./client";
import type { CallLogger } from "./http";

/** The only way app/script code should build a client: the key comes from server env. */
export function youcamFromEnv(logger?: CallLogger): YouCamClient {
  const env = serverEnv();
  return new YouCamClient({ apiKey: env.YOUCAM_API_KEY, baseUrl: env.YOUCAM_BASE_URL, logger });
}
