import type { Prisma, PrismaClient } from "../generated/prisma/client";
import type { BlobStore } from "../storage/blobs";
import { YouCamApiError, type CallLogger, type YouCamClient } from "../youcam";
import { DAY_MS } from "../time";

/** Version of the consent text in copy.ts; bump when the text changes. */
export const CONSENT_VERSION = "v2-2026-10";
export const CONSENT_KIND = "photo_tryon";
/** Buyer photos and try-on outputs are deleted automatically after this many days (stated in the consent text). */
export const RETENTION_DAYS = 30;

export interface DeletionSummary {
  photos: number;
  renders: number;
  /** complete-the-look images deleted with the renders */
  looks: number;
  /** YouCam task-delete results for the renders' tasks */
  youcam: { deleted: number; alreadyGone: number; failed: number };
  /** orders whose WhatsApp number was removed */
  phoneNumbers: number;
  /** order card links (and images) removed */
  cards: number;
  /** family vote links deleted */
  familyLinks: number;
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
   * outputs and its uploaded inputs), plus what was shared from them: the
   * WhatsApp number and card link on their orders, and family vote links.
   * Seeded sample photos are not the buyer's and are kept. Optionally only
   * data older than `before`.
   */
  async deletePhotos(buyerId: string, before?: Date): Promise<DeletionSummary> {
    const createdAt = before ? { createdAt: { lt: before } } : {};
    const { result, keys } = await this.deletePhotoSet({ buyerId, ...createdAt }, { buyerId, ...createdAt });
    await this.scrubMessages(buyerId, keys);
    return result;
  }

  /** Every buyer photo uploaded in one seller's chats (demo reset). Sample photos are never included. */
  async deleteSellerPhotos(sellerId: string): Promise<DeletionSummary> {
    return (await this.deletePhotoSet({ sellerId })).result;
  }

  /**
   * Delete a set of buyer photos and every render made from them, here and at
   * YouCam, and what was shared from those renders. `buyer` also covers that
   * buyer's own orders and family links (including ones made from sample photos).
   */
  private async deletePhotoSet(
    where: Prisma.BuyerPhotoWhereInput,
    buyer?: { buyerId: string; createdAt?: { lt: Date } },
  ): Promise<{ result: DeletionSummary; keys: Set<string> }> {
    const { prisma, blobs } = this.deps;
    const photos = await prisma.buyerPhoto.findMany({ where: { ...where, isSample: false }, include: { tryOns: true } });
    const renders = photos.flatMap((p) => p.tryOns);
    const renderIds = renders.map((r) => r.id);
    // complete-the-look images made from these renders (rows go with the renders; blobs and tasks here)
    const looks = await prisma.look.findMany({ where: { tryOnId: { in: renderIds } } });
    const lookSteps = await prisma.lookStep.findMany({ where: { tryOnId: { in: renderIds } } });
    const lookKeys = [
      ...renders.map((r) => r.closeupKey),
      ...looks.flatMap((l) => [l.outputKey, l.closeupKey]),
      ...lookSteps.map((st) => st.outputKey),
    ].filter((k): k is string => !!k);
    const shared = await this.deleteShared([{ tryOnId: { in: renderIds } }, ...(buyer ? [buyer] : [])]);

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
    // look steps uploaded a crop of the buyer's face: delete those tasks at YouCam too (not counted in the summary)
    for (const st of lookSteps.filter((x) => x.taskId)) {
      await yc.deleteTask(st.taskId!).catch(() => undefined);
    }

    const keys = [...photos.map((p) => p.blobKey), ...renders.map((r) => r.outputKey).filter((k): k is string => !!k)];
    await prisma.$transaction([
      // Orders keep their row for the seller but lose the image (tryOnId -> null via SetNull).
      prisma.tryOn.deleteMany({ where: { id: { in: renderIds } } }),
      prisma.buyerPhoto.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } }),
    ]);
    // Blob keys are content-addressed: only delete keys nothing else still uses.
    const stillUsed = new Set([
      ...(await prisma.buyerPhoto.findMany({ where: { blobKey: { in: keys } }, select: { blobKey: true } })).map((x) => x.blobKey),
      ...(await prisma.tryOn.findMany({ where: { outputKey: { in: keys } }, select: { outputKey: true } })).map((x) => x.outputKey!),
    ]);
    await blobs.delete(keys.filter((k) => !stillUsed.has(k)));
    // look images are content-addressed too: keep any that another (e.g. sample) render still uses
    const lookStillUsed = new Set(
      [
        ...(await prisma.look.findMany({ where: { OR: [{ outputKey: { in: lookKeys } }, { closeupKey: { in: lookKeys } }] }, select: { outputKey: true, closeupKey: true } })).flatMap((l) => [l.outputKey, l.closeupKey]),
        ...(await prisma.tryOn.findMany({ where: { closeupKey: { in: lookKeys } }, select: { closeupKey: true } })).map((x) => x.closeupKey),
        ...(await prisma.lookStep.findMany({ where: { outputKey: { in: lookKeys } }, select: { outputKey: true } })).map((x) => x.outputKey),
      ].filter((k): k is string => !!k),
    );
    await blobs.delete(lookKeys.filter((k) => !lookStillUsed.has(k)));
    return { result: { photos: photos.length, renders: renders.length, looks: looks.length, youcam, ...shared }, keys: new Set([...keys, ...lookKeys]) };
  }

  /** Clear WhatsApp numbers and card links on matching orders, and delete matching family links. */
  private async deleteShared(scopes: Array<Prisma.OrderWhereInput & Prisma.FamilyVoteWhereInput>) {
    const { prisma, blobs } = this.deps;
    const orders = await prisma.order.findMany({
      where: { AND: [{ OR: scopes }, { OR: [{ buyerWhatsapp: { not: null } }, { cardToken: { not: null } }, { cardImageKey: { not: null } }, { lookId: { not: null } }, { lookNeckBare: { not: null } }] }] },
      select: { id: true, buyerWhatsapp: true, cardToken: true, cardImageKey: true, lookItems: true },
    });
    if (orders.length) {
      await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { buyerWhatsapp: null, cardToken: null, cardImageKey: null, lookNeckBare: null } });
      // the look goes with the photos: keep only what was actually ordered (the seller's record), drop styling choices
      for (const o of orders) {
        if (!Array.isArray(o.lookItems)) continue;
        const ordered = (o.lookItems as Array<{ ordered?: boolean }>).filter((i) => i.ordered);
        await prisma.order.update({ where: { id: o.id }, data: { lookId: null, lookItems: ordered as unknown as Prisma.InputJsonValue } });
      }
      await blobs.delete(orders.map((o) => o.cardImageKey).filter((k): k is string => !!k));
    }
    const votes = await prisma.familyVote.deleteMany({ where: { OR: scopes } });
    return {
      phoneNumbers: orders.filter((o) => o.buyerWhatsapp).length,
      cards: orders.filter((o) => o.cardToken || o.cardImageKey).length,
      familyLinks: votes.count,
    };
  }

  /** Retention: delete every buyer photo (and its renders) older than RETENTION_DAYS. */
  async purgeExpired(): Promise<{ buyers: number; photos: number; renders: number; orders: number }> {
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
    // buyers who only used sample photos still gave a number / got a card link
    const shared = await this.deleteShared([{ createdAt: { lt: before } }]);
    return { buyers: owners.length, photos, renders, orders: Math.max(shared.phoneNumbers, shared.cards) };
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
