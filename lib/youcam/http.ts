import { YouCamApiError } from "./errors";
import type { ApiErrorBody } from "./types";

/** One line per HTTP call, including how many units it consumed. */
export interface CallLogEntry {
  at: string;
  method: string;
  /** API path, or host only for pre-signed storage URLs (never query strings) */
  path: string;
  httpStatus: number | "network-error";
  durationMs: number;
  /** 0 for calls that cannot charge; null when a charge happened but its size is unknown */
  units: number | null;
  attempt: number;
  note?: string;
}

export type CallLogger = (entry: CallLogEntry) => void;

export const consoleCallLogger: CallLogger = (e) => {
  console.log(
    `[youcam] ${e.method} ${e.path} -> ${e.httpStatus} ${e.durationMs}ms units=${e.units ?? "?"}` +
      (e.attempt > 1 ? ` attempt=${e.attempt}` : "") +
      (e.note ? ` ${e.note}` : ""),
  );
};

export interface HttpOptions {
  apiKey: string;
  baseUrl: string;
  logger?: CallLogger;
  fetchImpl?: typeof fetch;
  /** for tests */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<T> {
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  /**
   * "safe": retry on 429, network errors and 5xx (reads, free calls).
   * "rate-limit-only": retry only on 429, which the server rejected outright.
   *   Use for anything that can start a paid task: a network error or 5xx
   *   there may mean the task was created, and a retry would pay twice.
   */
  retry: "safe" | "rate-limit-only";
  /** units this call consumed, given the parsed body; defaults to 0 */
  unitsFor?: (body: T) => number | null;
  note?: string;
  /** default: the API key. "none" for the V1 auth call; { bearer } for a V1 access token */
  auth?: "none" | { bearer: string };
}

const MAX_ATTEMPTS = 5;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Http {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: CallLogger;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger ?? consoleCallLogger;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  log(entry: CallLogEntry) {
    this.logger(entry);
  }

  async request<T>(method: "GET" | "POST", path: string, ro: RequestOptions<T>): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v === null ? "null" : String(v));
    }

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            ...(ro.auth === "none" ? {} : { Authorization: `Bearer ${ro.auth?.bearer ?? this.opts.apiKey}` }),
            ...(ro.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        });
      } catch (err) {
        this.log({
          at: new Date().toISOString(),
          method,
          path,
          httpStatus: "network-error",
          durationMs: Date.now() - started,
          units: 0,
          attempt,
          note: ro.note,
        });
        if (ro.retry === "safe" && attempt < MAX_ATTEMPTS) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const text = await res.text();
      const durationMs = Date.now() - started;
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // non-JSON body (e.g. gateway error page); handled below
      }

      if (res.ok) {
        const body = parsed as T;
        this.log({
          at: new Date().toISOString(),
          method,
          path,
          httpStatus: res.status,
          durationMs,
          units: ro.unitsFor ? ro.unitsFor(body) : 0,
          attempt,
          note: ro.note,
        });
        return body;
      }

      this.log({
        at: new Date().toISOString(),
        method,
        path,
        httpStatus: res.status,
        durationMs,
        units: 0,
        attempt,
        note: ro.note,
      });

      const retryable = res.status === 429 || (ro.retry === "safe" && res.status >= 500);
      if (retryable && attempt < MAX_ATTEMPTS) {
        await this.sleep(retryAfterMs(res) ?? backoffMs(attempt));
        continue;
      }
      const errBody = (parsed ?? {}) as ApiErrorBody;
      throw new YouCamApiError(method, path, res.status, errBody.error_code, errBody.error ?? (parsed ? undefined : text.slice(0, 200)));
    }
  }
}

function backoffMs(attempt: number) {
  return Math.min(1000 * 2 ** (attempt - 1), 16_000);
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  return Number.isFinite(s) ? s * 1000 : undefined;
}
