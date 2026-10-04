import { createHash } from "node:crypto";

export const TRYON_FEATURE = "cloth-v3";

/**
 * Identity of a render: same garment photo + same person photo + same request
 * parameters gives a byte-identical output (verified live) and costs units
 * again, so it must never be requested twice.
 */
export function inputsHash(p: { garmentPhotoHash: string; personPhotoHash: string; category: string; changeShoes: boolean }): string {
  return createHash("sha256")
    .update([TRYON_FEATURE, p.category, `change_shoes=${p.changeShoes}`, p.garmentPhotoHash, p.personPhotoHash].join("|"))
    .digest("hex");
}
