import { NextResponse, type NextRequest } from "next/server";
import { getApp } from "@/lib/server/app";
import { isSeller, readBuyerId } from "@/lib/server/auth";

/**
 * Serves stored images. Garment and sample images are public. Buyer photos
 * and renders of them are personal data: only their buyer, or the seller they
 * were made for (via ?seller=<slug>&key=<key>, or the demo seller), may see them.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/media/[...key]">) {
  const key = (await ctx.params).key.join("/");
  const app = await getApp();
  if (!(await allowed(key, req))) return new NextResponse("not found", { status: 404 });
  const blob = await app.blobs.get(key);
  if (!blob) return new NextResponse("not found", { status: 404 });
  return new NextResponse(Buffer.from(blob.bytes), {
    headers: {
      "content-type": blob.contentType,
      // keys are content-addressed: the bytes behind a key never change
      "cache-control": key.startsWith("garment/") || key.startsWith("sample/") ? "public, max-age=31536000, immutable" : "private, max-age=3600",
    },
  });
}

async function allowed(key: string, req: NextRequest): Promise<boolean> {
  const { prisma } = await getApp();
  if (key.startsWith("garment/") || key.startsWith("sample/")) return true;

  const buyerExternalId = await readBuyerId();
  const sellerSlug = req.nextUrl.searchParams.get("seller");
  const sellerKey = req.nextUrl.searchParams.get("key");
  const sellerOk = async (sellerId: string | null | undefined) => {
    if (!sellerId || !sellerSlug) return false;
    const seller = await prisma.seller.findUnique({ where: { slug: sellerSlug } });
    return !!seller && seller.id === sellerId && (await isSeller(seller, sellerKey));
  };

  if (key.startsWith("buyer/")) {
    const photos = await prisma.buyerPhoto.findMany({ where: { blobKey: key }, include: { buyer: true } });
    for (const p of photos) {
      if (buyerExternalId && p.buyer?.externalId === buyerExternalId) return true;
      if (await sellerOk(p.sellerId)) return true;
    }
    return false;
  }
  if (key.startsWith("tryon/")) {
    const renders = await prisma.tryOn.findMany({ where: { outputKey: key }, include: { buyerPhoto: { include: { buyer: true } }, garment: true } });
    for (const t of renders) {
      if (t.buyerPhoto.isSample) return true;
      if (buyerExternalId && t.buyerPhoto.buyer?.externalId === buyerExternalId) return true;
      if (await sellerOk(t.garment.sellerId)) return true;
    }
    return false;
  }
  return false;
}
