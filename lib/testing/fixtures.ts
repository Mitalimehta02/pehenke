import sharp from "sharp";
import type { PrismaClient } from "../generated/prisma/client";
import { PrismaBlobStore, storeImage, type BlobStore } from "../storage/blobs";

/** A person-like portrait: grey backdrop, head, coloured torso, dark legs. */
export async function personImage(torso = "#2b6cb0", w = 600, h = 1000): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#d8d8d8"/>
    <circle cx="${w / 2}" cy="${h * 0.1}" r="${w * 0.11}" fill="#b28e73"/>
    <rect x="${w * 0.28}" y="${h * 0.19}" width="${w * 0.44}" height="${h * 0.33}" fill="${torso}"/>
    <rect x="${w * 0.33}" y="${h * 0.52}" width="${w * 0.34}" height="${h * 0.42}" fill="#333344"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export async function garmentImage(color = "#b0124a"): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="100%" height="100%" fill="#fff"/><rect x="150" y="80" width="400" height="740" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export async function seedBasics(prisma: PrismaClient, blobs: BlobStore = new PrismaBlobStore(prisma)) {
  const seller = await prisma.seller.create({ data: { slug: "asha-sarees", name: "Asha Sarees", accessKeyHash: "x", isDemo: true } });
  const g = await storeImage(blobs, "garment", await garmentImage());
  const garment = await prisma.garment.create({
    data: {
      sellerId: seller.id,
      label: "saree",
      category: "full_body",
      photoType: "flatlay",
      length: "floor",
      priceInr: 1899,
      photoKey: g.key,
      photoHash: g.hash,
      photoW: g.width,
      photoH: g.height,
      gateStatus: "approved",
      gateBy: "rules",
    },
  });
  const buyer = await prisma.buyer.create({ data: { channel: "web", externalId: "cookie-1" } });
  return { seller, garment, buyer, blobs };
}

export async function addBuyerPhoto(prisma: PrismaClient, blobs: BlobStore, buyerId: string | null, torso = "#2b6cb0") {
  const p = await storeImage(blobs, buyerId ? "buyer" : "sample", await personImage(torso));
  return prisma.buyerPhoto.create({
    data: { buyerId, isSample: !buyerId, blobKey: p.key, hash: p.hash, width: p.width, height: p.height, framing: "full", accepted: true },
  });
}
