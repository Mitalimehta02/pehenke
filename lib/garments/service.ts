import { sellerCopy } from "../engine/sellerCopy";
import type { Category, GarmentLength, PhotoType, Prisma, PrismaClient } from "../generated/prisma/client";
import type { GarmentGate } from "../gate/garmentGate";
import type { BlobStore } from "../storage/blobs";
import { storeImage } from "../storage/blobs";

export interface NewGarment {
  bytes: Uint8Array;
  label: string;
  category: Category;
  photoType: PhotoType;
  length?: GarmentLength | null;
  priceInr?: number | null;
  includesBlouse?: boolean;
  notes?: string | null;
  credit?: Prisma.InputJsonValue;
}

export class DuplicatePhotoError extends Error {}

export class GarmentService {
  constructor(private readonly d: { prisma: PrismaClient; blobs: BlobStore; gate: GarmentGate; now?: () => Date }) {}

  /** Store the photo, run the gate once, save the result with the garment. */
  async add(sellerId: string, g: NewGarment) {
    const { prisma, blobs, gate } = this.d;
    const stored = await storeImage(blobs, "garment", g.bytes);
    const dup = await prisma.garment.findUnique({ where: { sellerId_photoHash: { sellerId, photoHash: stored.hash } } });
    if (dup) throw new DuplicatePhotoError(`this photo is already used for "${dup.label}"`);
    const result = await gate.check({ bytes: stored.bytes, width: stored.width, height: stored.height, label: g.label, category: g.category, photoType: g.photoType });
    return prisma.garment.create({
      data: {
        sellerId,
        label: g.label.trim(),
        category: g.category,
        photoType: g.photoType,
        length: g.length ?? null,
        priceInr: g.priceInr ?? null,
        includesBlouse: g.includesBlouse ?? false,
        notes: g.notes?.trim() || null,
        credit: g.credit,
        photoKey: stored.key,
        photoHash: stored.hash,
        photoW: stored.width,
        photoH: stored.height,
        gateStatus: result.status,
        gateProblems: result.problems,
        gateAdvice: result.status === "approved" ? null : sellerCopy.gateAdvice(result),
        gateBy: result.by,
        gateAt: this.d.now?.() ?? new Date(),
      },
    });
  }

  /** needs_review path: the seller confirms the photo checklist; the garment becomes available. */
  async confirmChecklist(sellerId: string, garmentId: string) {
    const g = await this.d.prisma.garment.findFirst({ where: { id: garmentId, sellerId } });
    if (!g) throw new Error("garment not found for this seller");
    if (g.gateStatus !== "needs_review") return g;
    return this.d.prisma.garment.update({ where: { id: garmentId }, data: { sellerConfirmed: true } });
  }

  async setActive(sellerId: string, garmentId: string, active: boolean) {
    const g = await this.d.prisma.garment.findFirst({ where: { id: garmentId, sellerId } });
    if (!g) throw new Error("garment not found for this seller");
    return this.d.prisma.garment.update({ where: { id: garmentId }, data: { active } });
  }
}

/** Whether buyers can try this garment on. */
export const isTryable = (g: { active: boolean; gateStatus: string; sellerConfirmed: boolean }) =>
  g.active && (g.gateStatus === "approved" || (g.gateStatus === "needs_review" && g.sellerConfirmed));
