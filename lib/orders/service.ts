import type { OrderOutcome, PrismaClient } from "../generated/prisma/client";
import type { Engine } from "../engine/engine";
import { newToken } from "../sellers/keys";
import type { BlobStore } from "../storage/blobs";
import { buildOrderCard } from "./cardData";
import { storeCardImage } from "./cardImage";

/**
 * Order cards are never sent automatically: the seller sees the try-on, the
 * pixel-check result and the disclosure line, and approves or rejects. Only an
 * approved card goes to the buyer. An approved card gets a public link
 * (/card/<token>) and one shareable image, which the seller sends on WhatsApp
 * (cardSentAt) and can resend on dispatch (dispatchedAt). Outcome (delivered /
 * refused / cancelled) is recorded later for the pilot metrics.
 */
export class OrderService {
  constructor(private readonly d: { prisma: PrismaClient; blobs: BlobStore; engine: Engine; now?: () => Date }) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  async decide(sellerId: string, orderId: string, decision: "approve" | "reject", note?: string) {
    const { prisma } = this.d;
    const order = await prisma.order.findFirst({ where: { id: orderId, sellerId } });
    if (!order) throw new Error("order not found for this seller");
    if (order.cardStatus !== "pending_seller") return order;
    const approve = decision === "approve";
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        cardStatus: approve ? "approved" : "rejected",
        decidedAt: this.now(),
        sellerNote: note?.trim() || null,
        // a card link only while the try-on image exists (the buyer may have deleted it)
        cardToken: approve && order.tryOnId ? newToken() : null,
      },
    });
    if (approve && updated.cardToken) {
      // The image can also be made later, on first view: a rendering problem must not block the order.
      await this.ensureCardImage(orderId).catch((err) => console.error("[orders] card image failed", err));
    }
    await this.d.engine.onOrderDecided(orderId);
    return updated;
  }

  /** The stored card image key, rendering it first if needed; null if the order has no card. */
  async ensureCardImage(orderId: string): Promise<string | null> {
    const { prisma, blobs } = this.d;
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { garment: true, seller: true, tryOn: true, look: true } });
    if (!order?.cardToken || order.cardStatus !== "approved" || !order.tryOn?.outputKey) return null;
    if (order.cardImageKey && (await blobs.get(order.cardImageKey))) return order.cardImageKey;
    const card = buildOrderCard(order);
    // the look image if a look was ordered, else the plain try-on
    const [shown, garment] = await Promise.all([card.imageKey ? blobs.get(card.imageKey) : null, blobs.get(order.garment.photoKey)]);
    if (!shown) return null;
    const key = await storeCardImage(blobs, { card, tryOn: shown.bytes, garment: garment?.bytes ?? null });
    await prisma.order.update({ where: { id: orderId }, data: { cardImageKey: key } });
    return key;
  }

  /** Public card by its link token (approved orders whose try-on still exists). */
  async cardByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const order = await this.d.prisma.order.findUnique({ where: { cardToken: token }, include: { garment: true, seller: true, tryOn: true, look: true } });
    if (!order || order.cardStatus !== "approved" || !order.tryOn?.outputKey) return null;
    return order;
  }

  /** The seller opened "Send to buyer on WhatsApp" (first time recorded). */
  async markCardSent(sellerId: string, orderId: string) {
    const order = await this.approvedOrder(sellerId, orderId);
    if (order.cardSentAt) return order;
    return this.d.prisma.order.update({ where: { id: orderId }, data: { cardSentAt: this.now() } });
  }

  async markDispatched(sellerId: string, orderId: string) {
    const order = await this.approvedOrder(sellerId, orderId);
    if (order.dispatchedAt) return order;
    return this.d.prisma.order.update({ where: { id: orderId }, data: { dispatchedAt: this.now() } });
  }

  async setOutcome(sellerId: string, orderId: string, outcome: OrderOutcome) {
    const { prisma } = this.d;
    const order = await prisma.order.findFirst({ where: { id: orderId, sellerId } });
    if (!order) throw new Error("order not found for this seller");
    return prisma.order.update({ where: { id: orderId }, data: { outcome, outcomeAt: outcome === "pending" ? null : this.now() } });
  }

  private async approvedOrder(sellerId: string, orderId: string) {
    const order = await this.d.prisma.order.findFirst({ where: { id: orderId, sellerId, cardStatus: "approved" } });
    if (!order) throw new Error("approved order not found for this seller");
    return order;
  }
}
