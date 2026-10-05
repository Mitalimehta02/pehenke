// npm run db:seed  -> idempotent demo data: one demo seller, garments, two sample photos.
// Images come from spike-assets/ (gitignored, on the developer's machine); bytes are stored
// in the database (Blob), so the deployed app needs no local files. Credits come from
// spike-assets/SOURCES.md. No YouCam units are spent here.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getApp } from "@/lib/server/app";
import { hashKey, newSellerKey } from "@/lib/server/auth";
import { storeImage } from "@/lib/storage/blobs";
import type { Category, GarmentLength, PhotoType } from "@/lib/generated/prisma/client";
import { DuplicatePhotoError } from "@/lib/garments/service";

const ASSETS = path.join(process.cwd(), "spike-assets");

export const DEMO_SELLER = { slug: "meera-boutique", name: "Meera's Boutique" };

// saree-magenta.jpg was dropped after the pre-render: on Sample model B it rendered as a
// mid-calf open wrap, not a draped saree (2026-10-05).
const GARMENTS: Array<{ file: string; label: string; category: Category; photoType: PhotoType; length: GarmentLength; priceInr: number; includesBlouse?: boolean; notes?: string }> = [
  { file: "ghagra-museum-mannequin.jpg", label: "Mustard and maroon ghagra set", category: "full_body", photoType: "mannequin", length: "floor", priceInr: 2499 },
  { file: "saree-museum-mannequin.jpg", label: "Ivory zari silk saree", category: "full_body", photoType: "mannequin", length: "floor", priceInr: 3299, includesBlouse: true },
  { file: "lehenga-worn.jpg", label: "Sage and pink lehenga with dupatta", category: "full_body", photoType: "worn", length: "floor", priceInr: 8999, includesBlouse: true },
  { file: "lehenga-shop-mannequin.jpg", label: "Red velvet bridal lehenga", category: "full_body", photoType: "mannequin", length: "floor", priceInr: 6499, includesBlouse: true },
  { file: "kurti-green-worn.jpg", label: "Green printed kurti", category: "upper_body", photoType: "worn", length: "knee", priceInr: 899 },
];

const SAMPLES = [
  { file: "model1-full.jpg", name: "Sample model A" },
  { file: "model3-full.jpg", name: "Sample model B" },
];

/** Rows of the SOURCES.md tables: | `file` | [title](url) | author | [licence](url) or licence | notes | */
function credits(): Map<string, { source: string; sourceUrl: string; author: string; licence: string; licenceUrl: string | null }> {
  const md = readFileSync(path.join(ASSETS, "SOURCES.md"), "utf8");
  const out = new Map();
  for (const line of md.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    const file = /^`(.+)`$/.exec(cells[1] ?? "")?.[1];
    if (!file) continue;
    const src = /^\[(.+)\]\((.+)\)$/.exec(cells[2]);
    const lic = /^\[(.+)\]\((.+)\)$/.exec(cells[4]);
    out.set(file, {
      source: src?.[1] ?? cells[2],
      sourceUrl: src?.[2] ?? "",
      author: cells[3],
      licence: lic?.[1] ?? cells[4],
      licenceUrl: lic?.[2] ?? null,
    });
  }
  return out;
}

async function main() {
  const app = await getApp();
  const { prisma, blobs } = app;
  const credit = credits();

  let seller = await prisma.seller.findUnique({ where: { slug: DEMO_SELLER.slug } });
  if (!seller) {
    const key = newSellerKey();
    seller = await prisma.seller.create({ data: { ...DEMO_SELLER, accessKeyHash: hashKey(key), isDemo: true } });
    console.log(`created demo seller /seller/${seller.slug} (demo: no key needed; key for reference: ${key})`);
  } else {
    console.log(`demo seller exists: /seller/${seller.slug}`);
  }

  for (const g of GARMENTS) {
    const c = credit.get(g.file);
    if (!c) throw new Error(`${g.file} has no SOURCES.md entry: refusing to seed an image without a credit`);
    try {
      const created = await app.garments.add(seller.id, { ...g, bytes: readFileSync(path.join(ASSETS, "garments", g.file)), credit: c });
      console.log(`garment ${g.label}: gate ${created.gateStatus} (${created.gateBy})${created.gateAdvice ? ` - ${created.gateAdvice}` : ""}`);
    } catch (err) {
      if (err instanceof DuplicatePhotoError) console.log(`garment ${g.label}: already seeded`);
      else throw err;
    }
  }

  for (const s of SAMPLES) {
    const c = credit.get(s.file);
    if (!c) throw new Error(`${s.file} has no SOURCES.md entry`);
    const stored = await storeImage(blobs, "sample", readFileSync(path.join(ASSETS, "people", s.file)));
    const exists = await prisma.buyerPhoto.findFirst({ where: { isSample: true, hash: stored.hash } });
    if (exists) {
      console.log(`sample ${s.name}: already seeded`);
      continue;
    }
    await prisma.buyerPhoto.create({
      data: { isSample: true, sampleName: s.name, credit: c, blobKey: stored.key, hash: stored.hash, width: stored.width, height: stored.height, framing: "full", accepted: true },
    });
    console.log(`sample ${s.name}: seeded`);
  }

  const needsReview = await prisma.garment.count({ where: { sellerId: seller.id, gateStatus: "needs_review", sellerConfirmed: false } });
  if (needsReview) console.log(`\n${needsReview} garment(s) need the seller's photo checklist on /seller/${seller.slug} before buyers can try them.`);
  await app.ledger.flush();
}

if (process.argv[1]?.endsWith("seed.ts")) main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
