import { sellerCopy } from "../engine/sellerCopy";
import type { AccessoryType, Prisma, PrismaClient } from "../generated/prisma/client";
import { checkAccessoryPhoto, cropPhoto, type PixelBox } from "../gate/accessoryGate";
import type { BlobStore } from "../storage/blobs";
import { storeImage } from "../storage/blobs";

export interface NewAccessory {
  bytes: Uint8Array;
  type: AccessoryType;
  label: string;
  priceInr?: number | null;
  credit?: Prisma.InputJsonValue;
}

export class DuplicateAccessoryError extends Error {}

/**
 * Seller jewellery for "complete the look". The photo gate runs once when the
 * item is added. An earring pair photo is kept with a suggested one-earring
 * crop until the seller confirms it; only approved items reach buyers.
 */
export class AccessoryService {
  constructor(private readonly d: { prisma: PrismaClient; blobs: BlobStore; now?: () => Date }) {}

  async add(sellerId: string, a: NewAccessory) {
    const { prisma, blobs } = this.d;
    const stored = await storeImage(blobs, "accessory", a.bytes, 90);
    const dup = await prisma.accessory.findUnique({ where: { sellerId_photoHash: { sellerId, photoHash: stored.hash } } });
    if (dup) throw new DuplicateAccessoryError(`this photo is already used for "${dup.label}"`);
    // checked on the stored image, so a suggested crop is in its pixels
    const gate = await checkAccessoryPhoto({ bytes: stored.bytes, type: a.type });
    return prisma.accessory.create({
      data: {
        sellerId,
        type: a.type,
        label: a.label.trim(),
        priceInr: a.priceInr ?? null,
        credit: a.credit,
        photoKey: stored.key,
        photoHash: stored.hash,
        photoW: stored.width,
        photoH: stored.height,
        gateStatus: gate.status,
        gateProblems: gate.problems,
        gateAdvice: gate.status === "approved" ? null : sellerCopy.accessoryAdvice(a.type, gate.problems),
        gateBy: gate.by,
        gateAt: this.d.now?.() ?? new Date(),
        cropSuggestion: gate.cropSuggestion as unknown as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** Earring pair photo: the seller accepts the suggested crop to one earring. The item becomes available. */
  async confirmCrop(sellerId: string, accessoryId: string) {
    const { prisma, blobs } = this.d;
    const a = await prisma.accessory.findFirst({ where: { id: accessoryId, sellerId } });
    if (!a) throw new Error("jewellery item not found for this seller");
    const box = a.cropSuggestion as PixelBox | null;
    if (a.gateStatus !== "needs_review" || !box) return a;
    const photo = await blobs.get(a.photoKey);
    if (!photo) throw new Error("photo missing from storage");
    const stored = await storeImage(blobs, "accessory", await cropPhoto(photo.bytes, box), 90);
    return prisma.accessory.update({
      where: { id: a.id },
      data: {
        photoKey: stored.key,
        photoHash: stored.hash,
        photoW: stored.width,
        photoH: stored.height,
        originalKey: a.photoKey,
        gateStatus: "approved",
        gateBy: "rules+seller",
        gateAdvice: null,
        cropSuggestion: undefined,
      },
    });
  }

  async setActive(sellerId: string, accessoryId: string, active: boolean) {
    const a = await this.d.prisma.accessory.findFirst({ where: { id: accessoryId, sellerId } });
    if (!a) throw new Error("jewellery item not found for this seller");
    return this.d.prisma.accessory.update({ where: { id: a.id }, data: { active } });
  }

  /** Remove an item that isn't on any order (e.g. a rejected photo), with its images. */
  async remove(sellerId: string, accessoryId: string) {
    const { prisma, blobs } = this.d;
    const a = await prisma.accessory.findFirst({ where: { id: accessoryId, sellerId }, include: { _count: { select: { orderItems: true } } } });
    if (!a) throw new Error("jewellery item not found for this seller");
    if (a._count.orderItems) return prisma.accessory.update({ where: { id: a.id }, data: { active: false } });
    await prisma.accessory.delete({ where: { id: a.id } });
    await blobs.delete([a.photoKey, a.originalKey].filter((k): k is string => !!k));
    return null;
  }
}
