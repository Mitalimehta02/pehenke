import type { BlobStore } from "../storage/blobs";
import { storeImage } from "../storage/blobs";
import type { Ledger, RenderRefusal } from "../units/ledger";
import { RENDER_UNITS } from "../units/ledger";
import type { PrismaClient, TryOn } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import { TaskLostError, TaskPollTimeoutError, YouCamApiError, type CallLogger, type ClothesV3Result, type YouCamClient } from "../youcam";
import { checkBadRender } from "../guards/badRender";
import { checkGarmentLength } from "../guards/length";
import { decideCardVerdict } from "../verdict/cardVerdict";
import { inputsHash } from "./hash";
import { JobQueue } from "./queue";

/** Never swap the buyer's shoes: they don't order shoes (SPIKE.md). */
export const CHANGE_SHOES = false;

/** queued tryOns older than this with no task id never started (process died before the start call). */
const STALE_QUEUED_MS = 2 * 60_000;

export interface TryOnDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  ledger: Ledger;
  /** a YouCam client whose calls are logged with the given logger */
  youcam: (logger: CallLogger) => YouCamClient;
  /** called after a render reaches a final state (succeeded / failed / lost) */
  onFinished?: (tryOnId: string) => Promise<void>;
  pollTimeoutMs?: number;
  concurrency?: number;
  now?: () => Date;
}

export type TryOnRequestResult =
  | { kind: "cached"; tryOn: TryOn }
  | { kind: "joined"; tryOn: TryOn }
  | { kind: "started"; tryOn: TryOn }
  | { kind: "refused"; reason: RenderRefusal };

export class TryOnService {
  private readonly queue: JobQueue;
  private readonly now: () => Date;

  constructor(private readonly deps: TryOnDeps) {
    this.queue = new JobQueue(deps.concurrency ?? 2);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Get a render for (garment, person photo): reuse a finished one, join one in
   * progress, or start a new one if the caps allow. Never renders a hash twice.
   */
  async request(p: { garmentId: string; buyerPhotoId: string; buyerId: string | null }): Promise<TryOnRequestResult> {
    const { prisma } = this.deps;
    const garment = await prisma.garment.findUniqueOrThrow({ where: { id: p.garmentId } });
    const photo = await prisma.buyerPhoto.findUniqueOrThrow({ where: { id: p.buyerPhotoId } });
    const hash = inputsHash({ garmentPhotoHash: garment.photoHash, personPhotoHash: photo.hash, category: garment.category, changeShoes: CHANGE_SHOES });

    const existing = await prisma.tryOn.findUnique({ where: { inputsHash: hash } });
    if (existing?.status === "succeeded") return { kind: "cached", tryOn: existing };
    if (existing && (existing.status === "queued" || existing.status === "running")) return { kind: "joined", tryOn: existing };

    const allowed = await this.deps.ledger.canStartRender(p.buyerId);
    if (!allowed.ok) return { kind: "refused", reason: allowed.reason };

    // A failed or lost earlier attempt charged nothing we can recover: start over.
    if (existing) await prisma.tryOn.delete({ where: { id: existing.id } });
    let tryOn: TryOn;
    try {
      tryOn = await prisma.tryOn.create({
        data: {
          inputsHash: hash,
          garmentId: garment.id,
          buyerPhotoId: photo.id,
          requestedById: p.buyerId,
          category: garment.category,
          changeShoes: CHANGE_SHOES,
          status: "queued",
        },
      });
    } catch (err) {
      // Someone else created the same render a moment ago: wait for theirs.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { kind: "joined", tryOn: await prisma.tryOn.findUniqueOrThrow({ where: { inputsHash: hash } }) };
      }
      throw err;
    }
    this.queue.push(() => this.run(tryOn.id));
    return { kind: "started", tryOn };
  }

  /** Resume renders interrupted by a restart. Call once on server start. */
  async resumeAll(): Promise<{ resumed: number; abandoned: number }> {
    const { prisma } = this.deps;
    const running = await prisma.tryOn.findMany({ where: { status: "running", taskId: { not: null } } });
    for (const t of running) this.queue.push(() => this.poll(t.id));

    const queued = await prisma.tryOn.findMany({ where: { status: "queued" } });
    let abandoned = 0;
    for (const t of queued) {
      if (this.now().getTime() - t.createdAt.getTime() > STALE_QUEUED_MS) {
        await this.fail(t.id, "interrupted before the render started; try again");
        abandoned++;
      } else {
        this.queue.push(() => this.run(t.id));
      }
    }
    return { resumed: running.length + queued.length - abandoned, abandoned };
  }

  idle() {
    return this.queue.idle();
  }

  get caps() {
    return this.deps.ledger.caps;
  }

  // ---------------- internals ----------------

  private client(tryOnId: string) {
    return this.deps.youcam(this.deps.ledger.youcamLogger({ tryOnId }));
  }

  private async run(id: string) {
    const { prisma, blobs } = this.deps;
    const t = await prisma.tryOn.findUnique({ where: { id }, include: { garment: true, buyerPhoto: true } });
    if (!t || t.status !== "queued") return;
    const yc = this.client(id);
    try {
      const [person, garment] = await Promise.all([blobs.get(t.buyerPhoto.blobKey), blobs.get(t.garment.photoKey)]);
      if (!person || !garment) throw new Error("input image missing from storage");
      // Fresh uploads for every render: deleting a task deletes the inputs it ran on.
      const src = await yc.clothesV3.upload({ bytes: person.bytes, fileName: "person.jpg", contentType: "image/jpg" });
      const ref = await yc.clothesV3.upload({ bytes: garment.bytes, fileName: "garment.jpg", contentType: "image/jpg" });
      const taskId = await yc.clothesV3.start({ src_file_id: src, ref_file_id: ref, garment_category: t.category, change_shoes: t.changeShoes });
      // Persist the task id before polling: an abandoned task still charges.
      await prisma.tryOn.update({ where: { id }, data: { taskId, status: "running", startedAt: this.now() } });
    } catch (err) {
      const definite = err instanceof YouCamApiError && err.httpStatus < 500;
      await this.fail(id, definite ? `start rejected: ${err.errorCode ?? err.httpStatus}` : `start failed: ${(err as Error).message}`);
      return;
    }
    await this.poll(id);
  }

  private async poll(id: string) {
    const { prisma } = this.deps;
    const t = await prisma.tryOn.findUniqueOrThrow({ where: { id } });
    if (!t.taskId) return;
    const yc = this.client(id);
    try {
      const status = await yc.clothesV3.poll(t.taskId, { timeoutMs: this.deps.pollTimeoutMs ?? 5 * 60_000 });
      if (status.task_status === "success") await this.succeed(id, status.results);
      else await this.fail(id, status.error ?? "task error", status.error_message);
    } catch (err) {
      if (err instanceof TaskLostError) {
        // The docs say an un-polled task still charges and its result is gone.
        await prisma.tryOn.update({
          where: { id },
          data: { status: "lost", finishedAt: this.now(), units: RENDER_UNITS, unitsWasted: RENDER_UNITS, error: err.errorCode },
        });
        await this.deps.onFinished?.(id);
      } else if (err instanceof TaskPollTimeoutError) {
        // Still running: keep it; the next resume picks it up. Try again shortly.
        setTimeout(() => this.queue.push(() => this.poll(id)), 30_000).unref?.();
      } else {
        throw err;
      }
    }
  }

  private async succeed(id: string, results: ClothesV3Result | undefined) {
    const { prisma, blobs } = this.deps;
    const t = await prisma.tryOn.findUniqueOrThrow({ where: { id }, include: { garment: true, buyerPhoto: true } });
    if (!results?.url) return this.fail(id, "success without a result URL");
    const yc = this.client(id);
    // Result URLs expire in ~2h: store the image now.
    const dl = await yc.download(results.url);
    const out = await storeImage(blobs, "tryon", dl.bytes);
    const person = await blobs.get(t.buyerPhoto.blobKey);

    const bad = person ? await checkBadRender(person.bytes, out.bytes, "full", t.category) : undefined;
    // Advisory only (SPIKE.md: not reliable enough to block); shown to the seller.
    const length =
      person && t.garment.length
        ? await (async () => {
            const g = await blobs.get(t.garment.photoKey);
            return g ? checkGarmentLength({ input: person.bytes, output: out.bytes, garment: g.bytes, framing: "full", expectedLength: t.garment.length! }) : undefined;
          })()
        : undefined;
    const verdict = decideCardVerdict({
      garmentLabel: t.garment.label,
      framing: "full",
      audit: undefined,
      auditStatus: "not_configured",
      pixel: { regionUnchanged: bad?.flagged ?? false },
    });
    const finishedAt = this.now();
    await prisma.tryOn.update({
      where: { id },
      data: {
        status: "succeeded",
        finishedAt,
        latencyMs: t.startedAt ? finishedAt.getTime() - t.startedAt.getTime() : null,
        units: RENDER_UNITS,
        // the buyer pays nothing for a blocked preview, but we paid for the render
        unitsWasted: verdict.card_verdict === "block" ? RENDER_UNITS : 0,
        outputKey: out.key,
        outputW: out.width,
        outputH: out.height,
        pixelChecks: {
          regionUnchanged: bad?.flagged ?? null,
          changedPct: bad ? Math.round(bad.changedPct * 1000) / 10 : null,
          length: length ? { hemPos: Math.round(length.hemPos * 100) / 100, expected: length.expected, determined: length.determined, flagged: length.flagged } : null,
        },
        verdict: verdict.card_verdict,
        disclosureText: verdict.disclosure_text,
        blockReason: verdict.block_reason,
      },
    });
    if (verdict.card_verdict === "block") console.warn(`[tryon] ${id} blocked after render: ${verdict.block_reason} (${RENDER_UNITS} units wasted)`);
    await this.deps.onFinished?.(id);
  }

  private async fail(id: string, error: string, detail?: string) {
    await this.deps.prisma.tryOn.update({
      where: { id },
      data: { status: "failed", finishedAt: this.now(), error: detail ? `${error}: ${detail}` : error, units: 0 },
    });
    await this.deps.onFinished?.(id);
  }
}
