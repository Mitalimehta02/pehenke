import sharp from "sharp";
import type { GarmentCategory } from "@/lib/youcam";
import type { Framing } from "./store";

/**
 * First-pass detector for "the API returned the original clothes": compare
 * the clothing region of the input person photo with the same region of the
 * output, and flag when almost nothing changed. Uses a fixed box per
 * (framing, category) instead of segmentation, so thresholds are provisional
 * and must be calibrated against real outputs.
 */

/** a pixel counts as changed when any channel moved more than this (0-255) */
export const PIXEL_DIFF_THRESHOLD = 30;
/** flag when fewer than this fraction of region pixels changed */
export const MIN_CHANGED_FRACTION = 0.15;

const WIDTH = 256;

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Fractions of the image where the garment should land. */
export function clothingRegion(framing: Framing, category: GarmentCategory): Box {
  const x = { x0: 0.2, x1: 0.8 };
  if (framing === "chest") {
    // chest-up photo: the torso fills the lower half
    return { ...x, y0: 0.45, y1: 1 };
  }
  if (framing === "full") {
    switch (category) {
      case "upper_body":
        return { ...x, y0: 0.18, y1: 0.5 };
      case "lower_body":
        return { ...x, y0: 0.48, y1: 0.92 };
      case "shoes":
        return { ...x, y0: 0.88, y1: 1 };
      default:
        return { ...x, y0: 0.18, y1: 0.92 };
    }
  }
  return { ...x, y0: 0.2, y1: 0.9 };
}

export interface BadRenderResult {
  flagged: boolean;
  /** fraction (0-1) of region pixels that changed */
  changedPct: number;
  /** output aspect ratio differs from the input by more than 2% */
  aspectChanged: boolean;
}

export async function checkBadRender(
  input: Uint8Array,
  output: Uint8Array,
  framing: Framing,
  category: GarmentCategory,
): Promise<BadRenderResult> {
  const [mi, mo] = await Promise.all([sharp(input).metadata(), sharp(output).metadata()]);
  const arIn = mi.width! / mi.height!;
  const arOut = mo.width! / mo.height!;
  const height = Math.round(WIDTH / arIn);

  // Same grid for both; light blur so JPEG noise doesn't count as change.
  const raw = (b: Uint8Array) =>
    sharp(b).rotate().resize(WIDTH, height, { fit: "fill" }).blur(1).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([raw(input), raw(output)]);

  const box = clothingRegion(framing, category);
  const x0 = Math.floor(box.x0 * WIDTH);
  const x1 = Math.ceil(box.x1 * WIDTH);
  const y0 = Math.floor(box.y0 * height);
  const y1 = Math.min(height, Math.ceil(box.y1 * height));

  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * WIDTH + x) * 3;
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > PIXEL_DIFF_THRESHOLD) changed++;
      total++;
    }
  }
  const changedPct = total ? changed / total : 0;
  return {
    flagged: changedPct < MIN_CHANGED_FRACTION,
    changedPct,
    aspectChanged: Math.abs(arOut / arIn - 1) > 0.02,
  };
}
