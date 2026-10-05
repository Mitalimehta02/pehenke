import type { PrismaClient } from "../generated/prisma/client";

/**
 * Everything the seller page shows. Every number is scoped to this seller's
 * own conversations, garments and orders, so the demo seller's activity can
 * never appear in a real seller's funnel.
 */
export async function sellerDashboard(prisma: PrismaClient, sellerId: string) {
  const [garments, pending, recent] = await Promise.all([
    prisma.garment.findMany({ where: { sellerId }, orderBy: { createdAt: "desc" } }),
    prisma.order.findMany({
      where: { sellerId, cardStatus: "pending_seller" },
      include: { garment: true, tryOn: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: { sellerId, cardStatus: { not: "pending_seller" } },
      include: { garment: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);
  return { garments, pending, recent, funnel: await funnel(prisma, sellerId), units: await unitStats(prisma, sellerId) };
}

export type Dashboard = Awaited<ReturnType<typeof sellerDashboard>>;

export async function funnel(prisma: PrismaClient, sellerId: string) {
  const [chats, consented, photos, previews, orders, approved, delivered, refused, cancelled] = await Promise.all([
    prisma.conversation.count({ where: { sellerId } }),
    prisma.conversation.count({ where: { sellerId, buyer: { consents: { some: {} } } } }),
    prisma.buyerPhoto.count({ where: { sellerId, isSample: false, accepted: true } }),
    prisma.message.count({ where: { conversation: { sellerId }, direction: "out", kind: "image" } }),
    prisma.order.count({ where: { sellerId } }),
    prisma.order.count({ where: { sellerId, cardStatus: "approved" } }),
    prisma.order.count({ where: { sellerId, outcome: "delivered" } }),
    prisma.order.count({ where: { sellerId, outcome: "refused" } }),
    prisma.order.count({ where: { sellerId, outcome: "cancelled" } }),
  ]);
  return { chats, consented, photos, previews, orders, approved, delivered, refused, cancelled };
}

/** Units spent on this seller's garments, and how many went to renders the pixel checks blocked. */
export async function unitStats(prisma: PrismaClient, sellerId: string) {
  const agg = await prisma.tryOn.aggregate({
    where: { garment: { sellerId } },
    _sum: { units: true, unitsWasted: true },
    _count: { _all: true },
  });
  const blocked = await prisma.tryOn.count({ where: { garment: { sellerId }, unitsWasted: { gt: 0 } } });
  const units = agg._sum.units ?? 0;
  const wasted = agg._sum.unitsWasted ?? 0;
  return { renders: agg._count._all, blocked, units, wasted, wastedPct: units ? Math.round((wasted / units) * 1000) / 10 : 0 };
}

/** Database size, for the Neon free-plan limit (writes are blocked above it). */
export async function storageStats(prisma: PrismaClient) {
  const [row] = await prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`;
  const blobs = await prisma.blob.aggregate({ _sum: { size: true }, _count: { _all: true } });
  return { dbBytes: Number(row.bytes), blobBytes: blobs._sum.size ?? 0, blobCount: blobs._count._all };
}
