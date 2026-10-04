import type { OrderOutcome, PrismaClient } from "../generated/prisma/client";
import type { Engine } from "../engine/engine";

/**
 * Order cards are never sent automatically: the seller sees the try-on, the
 * pixel-check result and the disclosure line, and approves or rejects. Only an
 * approved card goes to the buyer. Outcome (delivered / refused / cancelled)
 * is recorded later for the pilot metrics.
 */
export class OrderService {
  constructor(private readonly d: { prisma: PrismaClient; engine: Engine; now?: () => Date }) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  async decide(sellerId: string, orderId: string, decision: "approve" | "reject", note?: string) {
    const { prisma } = this.d;
    const order = await prisma.order.findFirst({ where: { id: orderId, sellerId } });
    if (!order) throw new Error("order not found for this seller");
    if (order.cardStatus !== "pending_seller") return order;
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { cardStatus: decision === "approve" ? "approved" : "rejected", decidedAt: this.now(), sellerNote: note?.trim() || null },
    });
    await this.d.engine.onOrderDecided(orderId);
    return updated;
  }

  async setOutcome(sellerId: string, orderId: string, outcome: OrderOutcome) {
    const { prisma } = this.d;
    const order = await prisma.order.findFirst({ where: { id: orderId, sellerId } });
    if (!order) throw new Error("order not found for this seller");
    return prisma.order.update({ where: { id: orderId }, data: { outcome, outcomeAt: outcome === "pending" ? null : this.now() } });
  }
}
