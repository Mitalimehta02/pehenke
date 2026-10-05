import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";
import type { ZodType } from "zod";
import {
  AUDIT_PROMPT,
  GARMENT_GATE_PROMPT,
  garmentPhotoAuditJsonSchema,
  garmentPhotoAuditSchema,
  renderAuditJsonSchema,
  renderAuditSchema,
  type AuditImage,
  type GarmentPhotoAudit,
  type GarmentPhotoInput,
  type RenderAudit,
  type RenderAuditInput,
  type RenderAuditor,
} from "./types";

/**
 * Gemini render auditor via the Interactions API (official @google/genai SDK).
 *
 * Verified in Google's docs (2026-10-01): gemini-3.8-flash is stable, takes
 * images, and is on the free tier. Free-tier inputs MAY be used by Google to
 * improve its products, so this provider is for spike images only (see
 * CLAUDE.md). Requests are sent with store=false so Google doesn't keep them
 * for server-side conversation state.
 *
 * Rate limits are no longer published per model; Google shows them per
 * project in AI Studio only. So: one audit at a time, a minimum gap between
 * requests, and exponential backoff on 429 / 503.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Longest side sent to the model; keeps requests small and well under the 20MB inline limit. */
const MAX_SIDE = 1024;

export interface GeminiAuditorOptions {
  apiKey: string;
  model?: string;
  /** minimum time between request starts. Default 4s (<= 15 per minute). */
  minGapMs?: number;
  /** attempts including the first. Default 5. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** for tests: replaces the SDK call */
  create?: (params: object) => Promise<{ output_text?: string }>;
  /** called for every request attempt (retries included) with its HTTP status (200 on success) */
  onRequest?: (status: number | null) => void;
}

export class GeminiAuditor implements RenderAuditor {
  readonly name: string;
  private readonly model: string;
  private readonly minGapMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly create: (params: object) => Promise<{ output_text?: string }>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  /** set when the daily quota is exhausted: later audits fail fast instead of retrying */
  private exhausted: string | undefined;
  private readonly onRequest?: (status: number | null) => void;

  constructor(opts: GeminiAuditorOptions) {
    this.onRequest = opts.onRequest;
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.name = `gemini:${this.model}`;
    this.minGapMs = opts.minGapMs ?? 4000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.create) {
      this.create = opts.create;
    } else {
      const client = new GoogleGenAI({ apiKey: opts.apiKey });
      // SDK retries off: we own the backoff so the free-tier pacing is explicit.
      this.create = (params) => client.interactions.create(params as never, { maxRetries: 0 } as never) as Promise<{ output_text?: string }>;
    }
  }

  auditRender(input: RenderAuditInput): Promise<RenderAudit> {
    return this.serial(async () => {
      const [person, garment, output] = await Promise.all([shrink(input.person), shrink(input.garment), shrink(input.output)]);
      const prompt = AUDIT_PROMPT.replace("{label}", input.garmentLabel).replace("{category}", input.category);
      return this.request(
        [
          { type: "text", text: prompt },
          { type: "text", text: "Image 1: buyer's original photo." },
          { type: "image", data: person, mime_type: "image/jpeg" },
          { type: "text", text: "Image 2: seller's garment photo (reference)." },
          { type: "image", data: garment, mime_type: "image/jpeg" },
          { type: "text", text: "Image 3: try-on output." },
          { type: "image", data: output, mime_type: "image/jpeg" },
        ],
        renderAuditJsonSchema,
        renderAuditSchema,
      );
    });
  }

  auditGarmentPhoto(input: GarmentPhotoInput): Promise<GarmentPhotoAudit> {
    return this.serial(async () => {
      const prompt = GARMENT_GATE_PROMPT.replace("{label}", input.garmentLabel).replace("{category}", input.category).replace("{photoType}", input.photoType);
      return this.request(
        [
          { type: "text", text: prompt },
          { type: "image", data: await shrink(input.image), mime_type: "image/jpeg" },
        ],
        garmentPhotoAuditJsonSchema,
        garmentPhotoAuditSchema,
      );
    });
  }

  /** One request at a time: concurrent callers wait their turn (free-tier pacing). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request<T>(input: object[], jsonSchema: object, schema: ZodType<T>): Promise<T> {
    if (this.exhausted) throw new Error(`${this.name} daily quota exhausted: ${this.exhausted}`);
    const params = { model: this.model, store: false, input, response_format: { type: "text", mime_type: "application/json", schema: jsonSchema } };
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastStart + this.minGapMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
      try {
        const res = await this.create(params);
        this.onRequest?.(200);
        if (!res.output_text) throw new Error("Gemini returned no text");
        return schema.parse(JSON.parse(res.output_text));
      } catch (err) {
        const status = statusOf(err);
        if (status !== undefined) this.onRequest?.(status);
        // Seen live: the free tier allows 20 requests per day; that 429 won't clear with backoff.
        if (status === 429 && /per day|daily/i.test((err as Error).message ?? "")) {
          this.exhausted = (err as Error).message;
          throw err;
        }
        const retryable = status === 429 || status === 503;
        if (!retryable || attempt >= this.maxAttempts) throw err;
        const backoff = Math.min(5000 * 2 ** (attempt - 1), 60_000);
        console.warn(`  [audit] ${this.name} ${status}; retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${this.maxAttempts})`);
        await this.sleep(backoff);
      }
    }
  }
}

/** HTTP status from whichever error shape the SDK throws. */
export function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.statusCode, e.code, e.response?.status]) if (typeof v === "number") return v;
  return undefined;
}

async function shrink(img: AuditImage): Promise<string> {
  const buf = await withImageSlot(() => sharp(img.bytes).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer());
  return buf.toString("base64");
}
