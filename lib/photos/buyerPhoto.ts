import sharp from "sharp";

/**
 * Buyer photo check, pixels only (no vision model on buyer photos).
 *
 * Measured on the spike photos: background-subtraction framing cues fail on
 * busy backgrounds, so pixels can't reliably tell full-body from chest-up.
 * Only clear failures are rejected here; for the rest the engine asks the
 * buyer to confirm "head to toe", and only a confirmed photo counts as full.
 */

/** YouCam cloth-v3 minimum (512x384). */
export const MIN_LONG = 512;
export const MIN_SHORT = 384;
/** height/width below this is landscape: a standing full-body photo is portrait */
export const MIN_PORTRAIT_RATIO = 1.1;
/** reject anything bigger before decoding (the client resizes first) */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type PhotoRejection = "not_an_image" | "too_large" | "too_small" | "landscape";

export type PhotoCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: PhotoRejection; width?: number; height?: number };

export async function checkBuyerPhoto(bytes: Uint8Array): Promise<PhotoCheck> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "too_large" };
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    return { ok: false, reason: "not_an_image" };
  }
  if (!meta.width || !meta.height) return { ok: false, reason: "not_an_image" };
  // EXIF orientations 5-8 are stored rotated by 90 degrees
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  if (Math.max(width, height) < MIN_LONG || Math.min(width, height) < MIN_SHORT) return { ok: false, reason: "too_small", width, height };
  if (height / width < MIN_PORTRAIT_RATIO) return { ok: false, reason: "landscape", width, height };
  return { ok: true, width, height };
}
