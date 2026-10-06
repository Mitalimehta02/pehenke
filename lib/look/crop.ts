import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";
import type { Face } from "./faceFinder";

/**
 * Image geometry for "complete the look" (all free, local):
 *  - headCrop: the head-and-shoulders box the look features need (SPIKE.md)
 *  - headChanges: did the try-on change anything around the ears / forehead?
 *    (it should only change clothes: a change there is invented jewellery or
 *    fabric over the ears, and earrings must not be drawn on top)
 *  - pasteChanged: put a crop result back into the full-body image, changing
 *    only the pixels the API changed
 */

export interface CropBox {
  /** pixels in the full image */
  left: number;
  top: number;
  width: number;
  height: number;
  /** the crop is enlarged by this factor before it goes to the API */
  scale: number;
}

/** Crop width sent to the API (the spike used 960 for a 480 px crop). */
const TARGET_WIDTH = 960;
const MAX_SCALE = 3;

/**
 * Head-and-shoulders box around a face: 3.4 face-widths wide, from 1.2 above
 * the face centre to about 3 below (neck and collarbones), as in the spike.
 * Null when the photo doesn't contain enough below the face.
 */
export function headCrop(face: Face, imgW: number, imgH: number): CropBox | null {
  const s = face.size * imgW;
  const cx = face.cx * imgW;
  const cy = face.cy * imgH;
  const width = Math.min(imgW, Math.round(3.4 * s));
  const left = Math.max(0, Math.min(imgW - width, Math.round(cx - width / 2)));
  const top = Math.max(0, Math.round(cy - 1.2 * s));
  const height = Math.min(imgH - top, Math.round(4.25 * s));
  // needs the chin, the neck and some shoulder below the face centre
  if (top + height < cy + 1.6 * s || width < 2.4 * s) return null;
  const scale = Math.round(Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / width)) * 100) / 100;
  return { left, top, width, height, scale };
}

/**
 * Size of the crop as sent to the API. Both sides are multiples of 16: the API changes
 * odd sizes (verified live: 959x1199 came back as 960x1198, 960x1200 came back unchanged),
 * and a result of another size no longer lines up pixel for pixel with what was sent.
 * The stretch this adds is under 1% and is undone exactly when the result is pasted back.
 */
const SIZE_STEP = 16;
const toStep = (v: number) => Math.max(SIZE_STEP, Math.round(v / SIZE_STEP) * SIZE_STEP);
export const cropSize = (b: CropBox) => ({ width: toStep(b.width * b.scale), height: toStep(b.height * b.scale) });

/** The crop as sent to the API: enlarged, lossless PNG (so later steps and the paste-back compare exact pixels). */
export function cutCrop(image: Uint8Array, box: CropBox): Promise<Buffer> {
  const { width, height } = cropSize(box);
  return withImageSlot(async () => {
    // extract first, then resize (sharp applies extract before resize only when they are separate pipelines)
    const cut = await sharp(image).rotate().removeAlpha().extract({ left: box.left, top: box.top, width: box.width, height: box.height }).png().toBuffer();
    return sharp(cut).resize(width, height, { kernel: "lanczos3", fit: "fill" }).png().toBuffer();
  });
}

// ---------------- head changes (invented jewellery near the ears / forehead) ----------------

/** a pixel counts as changed when any channel moved more than this (0-255), after a light blur */
const HEAD_DIFF = 30;
/** more than this share of an ear or forehead zone changed = not clean (clean renders: 0-2%, SPIKE.md) */
export const HEAD_CHANGED_MAX_PCT = 4;
const GRID = 640;

export interface HeadChanges {
  /** largest changed share (%) of the two ear zones, and of the forehead zone */
  earPct: number;
  foreheadPct: number;
  /** ears and forehead are as in the buyer's own photo */
  clear: boolean;
}

/**
 * Compare the buyer's original photo with the try-on around the head. Both
 * show the same person in the same place, so the face found in the try-on
 * locates the zones in both.
 */
export async function headChanges(original: Uint8Array, tryOn: Uint8Array, face: Face): Promise<HeadChanges> {
  return withImageSlot(async () => {
    const m = await sharp(tryOn).metadata();
    const H = Math.round((GRID * m.height!) / m.width!);
    const raw = (b: Uint8Array) => sharp(b).rotate().removeAlpha().resize(GRID, H, { fit: "fill" }).blur(1).raw().toBuffer();
    const [a, b] = await Promise.all([raw(original), raw(tryOn)]);
    const cx = face.cx * GRID;
    const cy = face.cy * H;
    const s = face.size * GRID;
    const pct = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      let changed = 0;
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(GRID, Math.round(x1)); x++) {
          const i = (y * GRID + x) * 3;
          n++;
          if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > HEAD_DIFF) changed++;
        }
      }
      return n ? (changed / n) * 100 : 0;
    };
    const earPct = Math.max(pct(cx - 0.85 * s, cy - 0.05 * s, cx - 0.42 * s, cy + 0.6 * s), pct(cx + 0.42 * s, cy - 0.05 * s, cx + 0.85 * s, cy + 0.6 * s));
    const foreheadPct = pct(cx - 0.25 * s, cy - 0.8 * s, cx + 0.25 * s, cy - 0.3 * s);
    const round = (v: number) => Math.round(v * 10) / 10;
    return { earPct: round(earPct), foreheadPct: round(foreheadPct), clear: earPct <= HEAD_CHANGED_MAX_PCT && foreheadPct <= HEAD_CHANGED_MAX_PCT };
  });
}

// ---------------- paste-back ----------------

/** a crop pixel counts as changed by the API when any channel moved more than this (results are lossless PNG) */
const PASTE_DIFF = 6;
/**
 * Jewellery plus a lip colour change a few percent of the crop. If most of it differs,
 * the result isn't aligned with what was sent (or was altered everywhere): pasting it
 * would soften or change the buyer's whole face, so it is refused.
 */
export const MAX_CHANGED_SHARE = 0.4;

export class MisalignedResultError extends Error {}

export interface PasteResult {
  /** full image, PNG: identical to the base outside the changed pixels */
  full: Buffer;
  /** share of crop pixels the API changed, 0..1 */
  changedShare: number;
}

/**
 * Put the look back into the full-body image. `before` and `after` are the
 * enlarged crop as sent and as returned (same size). Only pixels that differ
 * are pasted (with a 1-2 px soft edge), so the rest of the buyer's image stays
 * exactly as the try-on made it, with no softening from the enlarge / reduce
 * round trip.
 */
export async function pasteChanged(base: Uint8Array, box: CropBox, before: Uint8Array, after: Uint8Array): Promise<PasteResult> {
  return withImageSlot(async () => {
    const A = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = A.info;
    const B = await sharp(after).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
    const mask = Buffer.alloc(w * h);
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.max(Math.abs(A.data[i * 3] - B[i * 3]), Math.abs(A.data[i * 3 + 1] - B[i * 3 + 1]), Math.abs(A.data[i * 3 + 2] - B[i * 3 + 2]));
      if (d > PASTE_DIFF) {
        mask[i] = 255;
        changed++;
      }
    }
    const baseRaw = () => sharp(base).rotate().removeAlpha();
    if (!changed) return { full: await baseRaw().png().toBuffer(), changedShare: 0 };
    if (changed / (w * h) > MAX_CHANGED_SHARE) {
      throw new MisalignedResultError(`the result differs from the crop on ${Math.round((changed / (w * h)) * 100)}% of its pixels`);
    }

    // grow the mask slightly and soften its edge (in enlarged-crop pixels), then reduce patch and mask together
    const soft = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).blur(1.6).linear(3, 0).blur(0.8).extractChannel(0).raw().toBuffer();
    if (soft.length !== w * h) throw new Error("paste mask has an unexpected size");
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = B[i * 3];
      rgba[i * 4 + 1] = B[i * 3 + 1];
      rgba[i * 4 + 2] = B[i * 3 + 2];
      rgba[i * 4 + 3] = soft[i];
    }
    const small = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).resize(box.width, box.height, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer();
    // cut the faint tail of the soft edge, so nothing a few pixels away from a change is touched
    for (let i = 3; i < small.length; i += 4) if (small[i] < 24) small[i] = 0;
    const patch = await sharp(small, { raw: { width: box.width, height: box.height, channels: 4 } }).png().toBuffer();
    const full = await baseRaw().composite([{ input: patch, left: box.left, top: box.top }]).png().toBuffer();
    return { full, changedShare: changed / (w * h) };
  });
}

// ---------------- earring result check ----------------

/** below this left/right balance an earring result counts as one ear only (good results: 0.59 and 0.75; the bad one: 0.00) */
export const ONE_SIDED_MAX_RATIO = 0.25;

/**
 * Did the earring step draw on both ears? Counts strongly changed pixels left
 * and right of the face (the face itself is excluded). `face` is the face
 * centre and size as fractions of the crop's width / height. A frontal face
 * (the only kind the pipeline accepts) should get an earring on each side.
 */
export async function earringSides(before: Uint8Array, after: Uint8Array, face: { cx: number; cy: number; size: number }): Promise<{ left: number; right: number; oneSided: boolean }> {
  return withImageSlot(async () => {
    const A = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = A.info;
    const B = await sharp(after).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
    const cx = face.cx * w;
    const cy = face.cy * h;
    const s = face.size * w;
    let left = 0;
    let right = 0;
    for (let y = Math.max(0, Math.round(cy - 0.3 * s)); y < Math.min(h, Math.round(cy + 1.0 * s)); y++) {
      for (let x = 0; x < w; x++) {
        if (Math.abs(x - cx) < 0.33 * s) continue;
        const i = (y * w + x) * 3;
        const d = Math.max(Math.abs(A.data[i] - B[i]), Math.abs(A.data[i + 1] - B[i + 1]), Math.abs(A.data[i + 2] - B[i + 2]));
        if (d <= 40) continue;
        if (x < cx) left++;
        else right++;
      }
    }
    const max = Math.max(left, right);
    return { left, right, oneSided: max > 0 && Math.min(left, right) / max < ONE_SIDED_MAX_RATIO };
  });
}
