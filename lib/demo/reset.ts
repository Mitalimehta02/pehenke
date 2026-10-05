import type { App } from "../app";
import { Prisma } from "../generated/prisma/client";

/**
 * "Reset demo data" (demo seller only): removes everything visitors created
 * while playing the demo (chats, orders, uploaded photos and their renders,
 * here and at YouCam, and garments added on the seller page), and keeps the
 * seeded garments and the cached sample-photo renders, so the demo stays
 * free to replay.
 */
export async function resetDemo(app: App, sellerId: string) {
  const { prisma } = app;
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  if (!seller.isDemo) throw new Error("reset is only available for the demo seller");

  const photos = await app.consent.deleteSellerPhotos(sellerId);
  // card images of orders made with sample photos (photo deletion only covers buyers' own photos)
  const cards = await prisma.order.findMany({ where: { sellerId, cardImageKey: { not: null } }, select: { cardImageKey: true } });
  await app.blobs.delete(cards.map((o) => o.cardImageKey!));
  const orders = await prisma.order.deleteMany({ where: { sellerId } });
  const chats = await prisma.conversation.deleteMany({ where: { sellerId } });

  // Garments added during the demo have no credit (seeded ones always do).
  const added = await prisma.garment.findMany({ where: { sellerId, credit: { equals: Prisma.DbNull } }, include: { tryOns: true } });
  const keys = [...added.map((g) => g.photoKey), ...added.flatMap((g) => g.tryOns.map((t) => t.outputKey)).filter((k): k is string => !!k)];
  await prisma.garment.deleteMany({ where: { id: { in: added.map((g) => g.id) } } });
  const stillUsed = new Set([
    ...(await prisma.garment.findMany({ where: { photoKey: { in: keys } }, select: { photoKey: true } })).map((g) => g.photoKey),
    ...(await prisma.tryOn.findMany({ where: { outputKey: { in: keys } }, select: { outputKey: true } })).map((t) => t.outputKey!),
  ]);
  await app.blobs.delete(keys.filter((k) => !stillUsed.has(k)));

  return { chats: chats.count, orders: orders.count, photos: photos.photos, renders: photos.renders, garments: added.length };
}
