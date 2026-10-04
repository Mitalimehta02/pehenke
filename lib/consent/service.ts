import type { PrismaClient } from "../generated/prisma/client";
import type { BlobStore } from "../storage/blobs";
import { YouCamApiError, type CallLogger, type YouCamClient } from "../youcam";
import { DAY_MS } from "../time";

/** Version of the consent text in copy.ts; bump when the text changes. */
export const CONSENT_VERSION = "v1-2026-10";
export const CONSENT_KIND = "photo_tryon";
/** Buyer photos and try-on outputs are deleted automatically after this many days (stated in the consent text). */
export const RETENTION_DAYS = 30;

export interface DeletionSummary {
  photos: number;
  renders: number;
  /** YouCam task-delete results for the renders' tasks */
  youcam: { deleted: number; alreadyGone: number; failed: number };
}

export interface ConsentDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  youcam: (logger: CallLogger) => YouCamClient;
  youcamLogger: () => CallLogger;
  now?: () => Date;
}

export class ConsentService {
  private readonly now: () => Date;
  constructor(private readonly deps: ConsentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async hasConsent(buyerId: string): Promise<boolean> {
    const c = await this.deps.prisma.consent.findFirst({ where: { buyerId, kind: CONSENT_KIND, version: CONSENT_VERSION, revokedAt: null } });
    return !!c;
  }

  async grant(buyerId: string) {
    if (await this.hasConsent(buyerId)) return;
    await this.deps.prisma.consent.create({ data: { buyerId, kind: CONSENT_KIND, version: CONSENT_VERSION } });
  }

  /** Withdraw consent: delete everything, then revoke. */
  async revoke(buyerId: string): Promise<DeletionSummary> {
    const summary = await this.deletePhotos(buyerId);
    await this.deps.prisma.consent.updateMany({ where: { buyerId, revokedAt: null }, data: { revokedAt: this.now() } });
    return summary;
  }

  /**
   * "Delete my photos": the buyer's uploaded photos and every render made from
   * them, in our database and at YouCam (task delete removes the task, its
   * outputs and its uploaded inputs). Seeded sample photos are not the
   * buyer's and are kept. Optionally only photos older than `before`.
   */
  async deletePhotos(buyerId: string, before?: Date): Promise<DeletionSummary> {
    const { prisma, blobs } = this.deps;
    const photos = await prisma.buyerPhoto.findMany({
      where: { buyerId, isSample: false, ...(before ? { createdAt: { lt: before } } : {}) },
      include: { tryOns: true },
    });
    const renders = photos.flatMap((p) => p.tryOns);

    const youcam = { deleted: 0, alreadyGone: 0, failed: 0 };
    const yc = this.deps.youcam(this.deps.youcamLogger());
    for (const t of renders.filter((r) => r.taskId && (r.status === "succeeded" || r.status === "failed"))) {
      try {
        await yc.deleteTask(t.taskId!);
        youcam.deleted++;
      } catch (err) {
        // InvalidTaskId: YouCam no longer has it (its own 24h retention). Anything else: report as failed.
        if (err instanceof YouCamApiError && err.errorCode === "InvalidTaskId") youcam.alreadyGone++;
        else youcam.failed++;
      }
    }

    const keys = [...photos.map((p) => p.blobKey), ...renders.map((r) => r.outputKey).filter((k): k is string => !!k)];
    await prisma.$transaction([
      // Orders keep their row for the seller but lose the image (tryOnId -> null via SetNull).
      prisma.tryOn.deleteMany({ where: { id: { in: renders.map((r) => r.id) } } }),
      prisma.buyerPhoto.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } }),
    ]);
    // Blob keys are content-addressed: only delete keys nothing else still uses.
    const stillUsed = new Set([
      ...(await prisma.buyerPhoto.findMany({ where: { blobKey: { in: keys } }, select: { blobKey: true } })).map((x) => x.blobKey),
      ...(await prisma.tryOn.findMany({ where: { outputKey: { in: keys } }, select: { outputKey: true } })).map((x) => x.outputKey!),
    ]);
    await blobs.delete(keys.filter((k) => !stillUsed.has(k)));
    await this.scrubMessages(buyerId, new Set(keys));

    return { photos: photos.length, renders: renders.length, youcam };
  }

  /** Retention: delete every buyer photo (and its renders) older than RETENTION_DAYS. */
  async purgeExpired(): Promise<{ buyers: number; photos: number; renders: number }> {
    const before = new Date(this.now().getTime() - RETENTION_DAYS * DAY_MS);
    const owners = await this.deps.prisma.buyerPhoto.findMany({
      where: { isSample: false, createdAt: { lt: before }, buyerId: { not: null } },
      distinct: ["buyerId"],
      select: { buyerId: true },
    });
    let photos = 0;
    let renders = 0;
    for (const o of owners) {
      const s = await this.deletePhotos(o.buyerId!, before);
      photos += s.photos;
      renders += s.renders;
    }
    return { buyers: owners.length, photos, renders };
  }

  /** Replace deleted images in the buyer's chat history with a placeholder. */
  private async scrubMessages(buyerId: string, keys: Set<string>) {
    if (!keys.size) return;
    const { prisma } = this.deps;
    const msgs = await prisma.message.findMany({ where: { conversation: { buyerId }, kind: { in: ["image", "card"] } } });
    for (const m of msgs) {
      const body = m.body as { mediaKey?: string };
      if (body?.mediaKey && keys.has(body.mediaKey)) {
        await prisma.message.update({ where: { id: m.id }, data: { kind: "text", body: { text: "[photo deleted]", deleted: true } } });
      }
    }
  }
}
