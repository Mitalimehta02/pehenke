import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Accessory, Look, PrismaClient, TryOn } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import type { BlobStore } from "../storage/blobs";
import { sha256, storeImage } from "../storage/blobs";
import { JobQueue } from "../tryon/queue";
import type { Ledger, RenderRefusal } from "../units/ledger";
import { LOOK_STEP_UNITS } from "../units/ledger";
import { TaskLostError, TaskPollTimeoutError, YouCamApiError, type CallLogger, type LookFeature, type YouCamClient } from "../youcam";
import { cropSize, cutCrop, headChanges, headCrop, pasteChanged, type CropBox } from "./crop";
import { findFaces, pickFace, type Face, type FaceFinder } from "./faceFinder";

/**
 * "Complete the look": necklace, earrings and a lip shade on a finished
 * try-on. The look features reject a full-body image, so the pipeline is
 *
 *   head-and-shoulders crop of the cached try-on (free, local)
 *     -> necklace -> earrings -> lipstick        (1 unit each, only the chosen ones)
 *     -> paste back only the pixels the API changed (free, local)
 *
 * Each paid step is cached by a hash of everything before it, so a look that
 * differs only in the lip shade re-uses the jewellery steps. Task ids are
 * saved before polling; failed steps cost nothing (verified live, SPIKE.md).
 */

/** Bump when the crop geometry or request parameters change (invalidates cached looks). */
export const PIPELINE_VERSION = "look-v1";
/**
 * Lipstick strength 0-100, tuned on the demo base (SPIKE.md): of 30 / 40 / 50 / 70, 50 painted the
 * colour closest to the proposed shade; 70 was visibly bolder, 30 barely showed.
 */
export const LIP_INTENSITY = 50;
export const LIP_TEXTURE = "matte";

const NECKLACE: LookFeature = "2d-vto/necklace";
const EARRING: LookFeature = "2d-vto/earring";
const MAKEUP: LookFeature = "makeup-vto";

export interface LookPrep {
  face?: Face;
  crop?: CropBox;
  /** ears and forehead unchanged by the try-on (earrings may be drawn) */
  earsClear?: boolean;
  earPct?: number;
  foreheadPct?: number;
  /** why no look can be made on this render */
  problem?: "no_face" | "several_faces" | "too_close" | "no_image";
}

export interface LookChoice {
  necklaceId?: string | null;
  earringId?: string | null;
  lip?: { hex: string; name: string } | null;
}

export type LookRefusal = RenderRefusal | "no_face" | "ears_covered" | "nothing_chosen" | "not_available";

export type LookRequestResult =
  | { kind: "cached"; look: Look }
  | { kind: "joined"; look: Look }
  | { kind: "started"; look: Look; newSteps: number }
  | { kind: "refused"; reason: LookRefusal };

interface Step {
  hash: string;
  feature: LookFeature;
  accessory?: Accessory;
  lipHex?: string;
}

export interface LookDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  ledger: Ledger;
  youcam: (logger: CallLogger) => YouCamClient;
  onFinished?: (lookId: string) => Promise<void>;
  /** face locator (tests inject a fixed face; default: the bundled pico detector) */
  findFaces?: FaceFinder;
  pollTimeoutMs?: number;
  now?: () => Date;
}

const h = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

/** An accessory buyers may pick: active and through the photo gate. */
export const accessoryTryable = (a: Pick<Accessory, "active" | "gateStatus">) => a.active && a.gateStatus === "approved";

export class LookService {
  private readonly queue = new JobQueue(1);
  private readonly now: () => Date;
  private readonly stepLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: LookDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  idle() {
    return this.queue.idle();
  }

  /**
   * Free, once per try-on: find the face, the head-and-shoulders crop, whether
   * the ears are as in the buyer's own photo, and store the close-up tile.
   */
  async prepare(tryOnId: string): Promise<{ prep: LookPrep; closeupKey: string | null }> {
    const { prisma, blobs } = this.deps;
    const t = await prisma.tryOn.findUniqueOrThrow({ where: { id: tryOnId }, include: { buyerPhoto: true } });
    if (t.lookPrep) return { prep: t.lookPrep as LookPrep, closeupKey: t.closeupKey };
    const save = async (prep: LookPrep, closeupKey: string | null = null) => {
      await prisma.tryOn.update({ where: { id: tryOnId }, data: { lookPrep: prep as unknown as Prisma.InputJsonValue, closeupKey } });
      return { prep, closeupKey };
    };
    const out = t.outputKey && t.status === "succeeded" && t.verdict !== "block" ? await blobs.get(t.outputKey) : null;
    if (!out) return { prep: { problem: "no_image" }, closeupKey: null };

    const picked = pickFace(await (this.deps.findFaces ?? findFaces)(out.bytes));
    if ("problem" in picked) return save({ problem: picked.problem });
    const meta = await sharp(out.bytes).metadata();
    const crop = headCrop(picked.face, meta.width!, meta.height!);
    if (!crop) return save({ problem: "too_close" });

    const original = await blobs.get(t.buyerPhoto.blobKey);
    // without the original photo nothing can be compared: don't draw earrings
    const head = original ? await headChanges(original.bytes, out.bytes, picked.face) : { earPct: 100, foreheadPct: 100, clear: false };
    const closeup = await storeImage(blobs, "look", await cutCrop(out.bytes, crop), 88);
    return save({ face: picked.face, crop, earsClear: head.clear, earPct: head.earPct, foreheadPct: head.foreheadPct }, closeup.key);
  }

  /** Reuse a finished look, join one in progress, or start a new one if the caps allow. */
  async request(p: { tryOnId: string; buyerId: string | null } & LookChoice): Promise<LookRequestResult> {
    const { prisma } = this.deps;
    const tryOn = await prisma.tryOn.findUnique({ where: { id: p.tryOnId }, include: { garment: true } });
    if (!tryOn?.outputKey) return { kind: "refused", reason: "not_available" };
    const { prep } = await this.prepare(tryOn.id);
    if (!prep.crop) return { kind: "refused", reason: "no_face" };

    const pick = async (id: string | null | undefined, type: "necklace" | "earring") => {
      if (!id) return null;
      const a = await prisma.accessory.findFirst({ where: { id, sellerId: tryOn.garment.sellerId, type } });
      return a && accessoryTryable(a) ? a : undefined;
    };
    const necklace = await pick(p.necklaceId, "necklace");
    const earring = await pick(p.earringId, "earring");
    if (necklace === undefined || earring === undefined) return { kind: "refused", reason: "not_available" };
    const lip = p.lip && /^#[0-9a-f]{6}$/i.test(p.lip.hex) ? { hex: p.lip.hex.toLowerCase(), name: p.lip.name } : null;
    if (!necklace && !earring && !lip) return { kind: "refused", reason: "nothing_chosen" };
    if (earring && !prep.earsClear) return { kind: "refused", reason: "ears_covered" };

    const steps = this.plan(tryOn, prep.crop, necklace, earring, lip?.hex ?? null);
    const inputsHash = steps[steps.length - 1].hash;
    const existing = await prisma.look.findUnique({ where: { inputsHash } });
    if (existing?.status === "succeeded") return { kind: "cached", look: existing };
    if (existing && (existing.status === "queued" || existing.status === "running")) return { kind: "joined", look: existing };

    const done = await prisma.lookStep.findMany({ where: { hash: { in: steps.map((s) => s.hash) }, status: "succeeded" }, select: { hash: true } });
    const newSteps = steps.length - done.length;
    if (newSteps > 0) {
      const allowed = await this.deps.ledger.canStartLook(p.buyerId, newSteps);
      if (!allowed.ok) return { kind: "refused", reason: allowed.reason };
    }
    if (existing) await prisma.look.delete({ where: { id: existing.id } }); // failed earlier: nothing was charged
    let look: Look;
    try {
      look = await prisma.look.create({
        data: {
          inputsHash,
          tryOnId: tryOn.id,
          // a look assembled only from cached steps costs nothing and doesn't count against the buyer
          requestedById: newSteps > 0 ? p.buyerId : null,
          necklaceId: necklace?.id ?? null,
          earringId: earring?.id ?? null,
          lipHex: lip?.hex ?? null,
          lipName: lip?.name ?? null,
          status: "queued",
          stepHashes: steps.map((s) => s.hash),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { kind: "joined", look: await prisma.look.findUniqueOrThrow({ where: { inputsHash } }) };
      }
      throw err;
    }
    this.queue.push(() => this.run(look.id));
    return { kind: "started", look, newSteps };
  }

  /** Units a look with these choices would cost now (uncached steps), without starting anything. */
  async estimate(p: { tryOnId: string } & LookChoice): Promise<number> {
    const { prisma } = this.deps;
    const tryOn = await prisma.tryOn.findUniqueOrThrow({ where: { id: p.tryOnId } });
    const { prep } = await this.prepare(tryOn.id);
    if (!prep.crop) return 0;
    const acc = async (id?: string | null) => (id ? await prisma.accessory.findUnique({ where: { id } }) : null);
    const steps = this.plan(tryOn, prep.crop, await acc(p.necklaceId), await acc(p.earringId), p.lip?.hex.toLowerCase() ?? null);
    if (!steps.length) return 0;
    const done = await prisma.lookStep.count({ where: { hash: { in: steps.map((s) => s.hash) }, status: "succeeded" } });
    return (steps.length - done) * LOOK_STEP_UNITS;
  }

  /** Resume looks interrupted by a restart (a running step is polled, never started twice). */
  async resumeAll(): Promise<number> {
    const open = await this.deps.prisma.look.findMany({ where: { status: { in: ["queued", "running"] } } });
    for (const l of open) this.queue.push(() => this.run(l.id));
    return open.length;
  }

  // ---------------- internals ----------------

  /** Steps in pipeline order, each identified by a hash of everything before it. */
  private plan(tryOn: TryOn, crop: CropBox, necklace: Accessory | null, earring: Accessory | null, lipHex: string | null): Step[] {
    const steps: Step[] = [];
    let prev = h(PIPELINE_VERSION, tryOn.outputKey!, JSON.stringify(crop));
    if (necklace) steps.push({ hash: (prev = h(prev, NECKLACE, necklace.photoHash)), feature: NECKLACE, accessory: necklace });
    if (earring) steps.push({ hash: (prev = h(prev, EARRING, earring.photoHash)), feature: EARRING, accessory: earring });
    if (lipHex) steps.push({ hash: (prev = h(prev, MAKEUP, lipHex, LIP_TEXTURE, String(LIP_INTENSITY))), feature: MAKEUP, lipHex });
    return steps;
  }

  private client(tryOnId: string) {
    return this.deps.youcam(this.deps.ledger.youcamLogger({ tryOnId, unitsPerSuccess: LOOK_STEP_UNITS }));
  }

  private body(step: Step, srcId: string, refId?: string): object {
    if (step.feature === MAKEUP) {
      return {
        src_file_id: srcId,
        version: "1.0",
        effects: [
          // smoothing is applied at 50 unless told otherwise: 0 keeps the buyer's skin as it is
          { category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 },
          { category: "lip_color", shape: { name: "original" }, morphology: { fullness: 0, wrinkless: 0 }, style: { type: "full" }, palettes: [{ color: step.lipHex, texture: LIP_TEXTURE, colorIntensity: LIP_INTENSITY }] },
        ],
      };
    }
    // Optional anchor / location / scale fields are omitted: null is a 400 (verified live, SPIKE.md).
    const parameter =
      step.feature === NECKLACE
        ? { necklace_need_remove_background: true, necklace_shadow_intensity: 0.5, necklace_ambient_light_intensity: 0.5 }
        : { earring_need_remove_background: true, earring_is_right_ear: true, earring_occluded_type: 0, earring_shadow_intensity: 0.5, earring_ambient_light_intensity: 0.5 };
    return { src_file_id: srcId, ref_file_ids: [refId], source_info: { name: srcId }, object_infos: [{ name: refId, parameter }] };
  }

  private async run(lookId: string) {
    const { prisma, blobs } = this.deps;
    const look = await prisma.look.findUnique({ where: { id: lookId }, include: { tryOn: true, necklace: true, earring: true } });
    if (!look || (look.status !== "queued" && look.status !== "running")) return;
    const prep = look.tryOn.lookPrep as LookPrep | null;
    const base = look.tryOn.outputKey ? await blobs.get(look.tryOn.outputKey) : null;
    if (!prep?.crop || !base) return this.fail(lookId, "try-on image missing");
    await prisma.look.update({ where: { id: lookId }, data: { status: "running" } });

    const before = await cutCrop(base.bytes, prep.crop);
    let cur: Uint8Array = before;
    const steps = this.plan(look.tryOn, prep.crop, look.necklace, look.earring, look.lipHex);
    for (const step of steps) {
      let r: { bytes: Uint8Array; charged: number } | { error: string } | "still_running";
      try {
        r = await this.withStepLock(step.hash, () => this.runStep(look.tryOnId, step, cur));
      } catch (err) {
        r = { error: (err as Error).message };
      }
      if (r === "still_running") {
        // keep the look running; the task id is saved, so a later attempt polls it again
        setTimeout(() => this.queue.push(() => this.run(lookId)), 30_000).unref?.();
        return;
      }
      if ("error" in r) return this.fail(lookId, `${step.feature}: ${r.error}`);
      // recorded as each step is paid, so an interrupted run never under-counts (seen live)
      if (r.charged) await prisma.look.update({ where: { id: lookId }, data: { units: { increment: r.charged } } });
      cur = r.bytes;
    }

    let pasted;
    try {
      pasted = await pasteChanged(base.bytes, prep.crop, before, cur);
    } catch (err) {
      // e.g. the API returned an image that doesn't line up with the crop: never paste that
      return this.fail(lookId, `paste-back refused: ${(err as Error).message}`);
    }
    const full = await storeImage(blobs, "look", pasted.full, 90);
    const closeup = await storeImage(blobs, "look", cur, 90);
    await prisma.look.update({
      where: { id: lookId },
      data: { status: "succeeded", finishedAt: this.now(), outputKey: full.key, closeupKey: closeup.key },
    });
    await this.deps.onFinished?.(lookId);
  }

  /** One paid step: cached result, or resume its saved task, or start it (never twice). */
  private async runStep(tryOnId: string, step: Step, input: Uint8Array): Promise<{ bytes: Uint8Array; charged: number } | { error: string } | "still_running"> {
    const { prisma, blobs } = this.deps;
    const row = await prisma.lookStep.findUnique({ where: { hash: step.hash } });
    if (row?.status === "succeeded" && row.outputKey) {
      const cached = await blobs.get(row.outputKey);
      if (cached) return { bytes: cached.bytes, charged: 0 };
    }
    const yc = this.client(tryOnId);
    let taskId = row?.status === "running" ? row.taskId : null;
    if (!taskId) {
      await prisma.lookStep.upsert({
        where: { hash: step.hash },
        create: { hash: step.hash, tryOnId, feature: step.feature, status: "queued" },
        update: { status: "queued", taskId: null, error: null, outputKey: null, outputHash: null, units: 0, finishedAt: null },
      });
      try {
        const srcId = await yc.upload(step.feature, { bytes: input, fileName: "crop.png", contentType: "image/png" });
        let refId: string | undefined;
        if (step.accessory) {
          const ref = await blobs.get(step.accessory.photoKey);
          if (!ref) throw new Error("accessory photo missing from storage");
          refId = await yc.upload(step.feature, { bytes: ref.bytes, fileName: "item.jpg", contentType: "image/jpg" });
        }
        // never auto-retried on network errors or 5xx: a second POST could create a second paid task
        taskId = await yc.startTask(step.feature, this.body(step, srcId, refId));
        // before polling: an abandoned task may still charge
        await prisma.lookStep.update({ where: { hash: step.hash }, data: { taskId, status: "running" } });
      } catch (err) {
        const msg = err instanceof YouCamApiError ? `start rejected: ${err.errorCode ?? err.httpStatus}` : `start failed: ${(err as Error).message}`;
        await prisma.lookStep.update({ where: { hash: step.hash }, data: { status: "failed", error: msg, finishedAt: this.now() } });
        return { error: msg };
      }
    }
    try {
      const st = await yc.pollTask<unknown>(step.feature, taskId, { timeoutMs: this.deps.pollTimeoutMs ?? 5 * 60_000 });
      if (st.task_status !== "success") {
        const msg = `${st.error ?? "task error"}${st.error_message ? `: ${st.error_message}` : ""}`;
        await prisma.lookStep.update({ where: { hash: step.hash }, data: { status: "failed", error: msg, finishedAt: this.now() } });
        return { error: msg };
      }
      const url = findUrl(st.results);
      if (!url) throw new Error("success without a result URL");
      const dl = await yc.download(url); // result URLs expire in ~2h: store now
      const want = await sharp(input).metadata();
      const got = await sharp(dl.bytes).metadata();
      if (got.width !== want.width || got.height !== want.height) {
        console.warn(`[look] ${step.feature} returned ${got.width}x${got.height} for a ${want.width}x${want.height} crop`);
      }
      // keep it lossless and the size of the input, so later steps and the paste-back compare exact pixels
      const png = await sharp(dl.bytes).removeAlpha().resize(want.width, want.height, { fit: "fill" }).png().toBuffer();
      const key = `lookstep/${step.hash.slice(0, 32)}.png`;
      await blobs.put(key, png, { contentType: "image/png", width: want.width!, height: want.height! });
      await prisma.lookStep.update({
        where: { hash: step.hash },
        data: { status: "succeeded", units: LOOK_STEP_UNITS, outputKey: key, outputHash: sha256(png), finishedAt: this.now() },
      });
      return { bytes: png, charged: LOOK_STEP_UNITS };
    } catch (err) {
      if (err instanceof TaskPollTimeoutError) return "still_running";
      const msg = err instanceof TaskLostError ? `task lost: ${err.errorCode}` : (err as Error).message;
      // a lost task may have charged (docs): record the unit so the caps stay honest
      await prisma.lookStep.update({ where: { hash: step.hash }, data: { status: err instanceof TaskLostError ? "lost" : "failed", units: err instanceof TaskLostError ? LOOK_STEP_UNITS : 0, error: msg, finishedAt: this.now() } });
      return { error: msg };
    }
  }

  private async fail(lookId: string, error: string) {
    await this.deps.prisma.look.update({ where: { id: lookId }, data: { status: "failed", error, finishedAt: this.now() } });
    await this.deps.onFinished?.(lookId);
  }

  private async withStepLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.stepLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.stepLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.stepLocks.get(key) === next) this.stepLocks.delete(key);
    }
  }
}

/** First http(s) URL anywhere in a task's results (the docs show both `results.url` and `results[].download_url`). */
export function findUrl(o: unknown): string | null {
  if (typeof o === "string") return /^https?:\/\//.test(o) ? o : null;
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) {
      const u = findUrl(v);
      if (u) return u;
    }
  }
  return null;
}

export { cropSize };
