import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";
import type { Framing } from "./types";

/**
 * "What changed outside the garment" guard, pixels only (no API calls).
 *
 * Garment length: find where the reference garment's colours end in the
 * output, as a fraction of the person's height, and compare with the length
 * expected for that garment. Catches e.g. a choli rendered tunic-length.
 * Full-body framing only (the feet must be in frame). Thresholds are
 * provisional, calibrated on the first 4 outputs.
 *
 * Added jewellery/accessories is NOT detected here. Two pixel approaches were
 * tried on the first outputs and both missed the invented necklace:
 *  - generic skin-colour model + "small non-skin bits enclosed by skin":
 *    labels hair and gold/beige zari as skin, flags every output;
 *  - "changed pixels matching neither the garment's nor the kept person's
 *    colours": the render relights the garment so its own colours count as
 *    invented (20-35% of the person), while the thin necklace blurs away.
 * Detecting added items needs a vision model or human review (see SPIKE.md).
 */

const W = 400; // analysis width; height follows the input's aspect ratio

/** Where a garment's hem should land, as a fraction of head-top-to-feet height. */
export const LENGTHS = {
  crop: [0.25, 0.42],
  waist: [0.33, 0.5],
  hip: [0.42, 0.6],
  knee: [0.55, 0.8],
  ankle: [0.75, 1.0],
  floor: [0.82, 1.0],
} as const;
export type GarmentLength = keyof typeof LENGTHS;
export const GARMENT_LENGTHS = Object.keys(LENGTHS) as GarmentLength[];

/** Default expected length from the garment label, when garments.csv gives none. */
export function defaultLength(label: string): GarmentLength | undefined {
  const l = label.toLowerCase();
  if (/choli|blouse|crop/.test(l)) return "crop";
  if (/\btop\b|shirt|t-shirt|tee/.test(l)) return "hip";
  if (/kurti|kurta/.test(l)) return "knee";
  if (/saree|sari|lehenga|ghagra|gown|anarkali/.test(l)) return "floor";
  return undefined;
}

export interface LengthResult {
  flagged: boolean;
  expected: GarmentLength;
  /** hem position as a fraction of the person's height (0 = head top, 1 = feet) */
  hemPos: number;
  /**
   * false when the garment's colours couldn't be found in the output (e.g. a
   * worn or mannequin reference whose palette mixes in skin and background):
   * the hem is unknown, so nothing is flagged.
   */
  determined: boolean;
}

/** fewer garment-coloured rows than this fraction of body height = hem undetermined */
const MIN_GARMENT_ROWS = 0.08;
/** a row belongs to the garment when this fraction of the person's width matches its colours */
const ROW_COVERAGE = 0.25;

/** colour distance under which a pixel "matches" a palette colour (RGB) */
const PALETTE_MATCH = 42;
/** tolerance around the expected hem range */
export const LENGTH_TOLERANCE = 0.05;

interface Img {
  w: number;
  h: number;
  px: Buffer;
}

async function load(input: Uint8Array, w: number, h?: number): Promise<Img> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(w, h, { fit: "fill" })
    .blur(0.8)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, px: data };
}

/**
 * Foreground mask: pixels that differ from their row's background, estimated
 * from the outer 5% columns on each side (copes with wall above, floor below).
 */
function foreground(img: Img): Uint8Array {
  const m = new Uint8Array(img.w * img.h);
  const edge = Math.max(2, Math.round(img.w * 0.05));
  for (let y = 0; y < img.h; y++) {
    const samples: number[][] = [];
    for (let x = 0; x < edge; x++) samples.push(px(img, x, y), px(img, img.w - 1 - x, y));
    const bg = [0, 1, 2].map((c) => median(samples.map((s) => s[c])));
    for (let x = 0; x < img.w; x++) m[y * img.w + x] = dist(px(img, x, y), bg) > 45 ? 1 : 0;
  }
  return m;
}

/** Rows spanned by the person (head top to feet). */
function verticalExtent(mask: Uint8Array, w: number, h: number) {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += mask[y * w + x];
    if (n > w * 0.03) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return { top: Math.max(0, top), bottom: bottom < 0 ? h - 1 : bottom };
}

/** k-means colours (deterministic init). */
function palette(pts: number[][], k: number): number[][] {
  if (pts.length <= k) return pts;
  const sorted = [...pts].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let cents = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]);
  for (let it = 0; it < 12; it++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let best = 0;
      for (let c = 1; c < k; c++) if (dist(p, cents[c]) < dist(p, cents[best])) best = c;
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      sums[best][3]++;
    }
    cents = sums.map((s, i) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cents[i]));
  }
  return cents;
}

function sample(pts: number[][], max: number) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  return Array.from({ length: max }, (_, i) => pts[Math.floor(i * step)]);
}

const near = (p: number[], pal: number[][]) => pal.some((c) => dist(p, c) < PALETTE_MATCH);

export function checkGarmentLength(...args: Parameters<typeof checkGarmentLengthUnlimited>): Promise<LengthResult | undefined> {
  return withImageSlot(() => checkGarmentLengthUnlimited(...args));
}

async function checkGarmentLengthUnlimited(opts: {
  input: Uint8Array;
  output: Uint8Array;
  garment: Uint8Array;
  framing: Framing;
  expectedLength?: GarmentLength;
}): Promise<LengthResult | undefined> {
  if (opts.framing !== "full" || !opts.expectedLength) return undefined;
  const a = await load(opts.input, W);
  const b = await load(opts.output, a.w, a.h);
  const fgA = foreground(a);
  const fgB = foreground(b);
  const person = verticalExtent(fgA, a.w, a.h);

  // Reference garment colours (its background removed the same way).
  const g = await load(opts.garment, 200);
  const fgG = foreground(g);
  const gPts: number[][] = [];
  for (let i = 0; i < fgG.length; i++) if (fgG[i]) gPts.push([g.px[i * 3], g.px[i * 3 + 1], g.px[i * 3 + 2]]);
  const garmentPal = palette(sample(gPts, 6000), 8);

  // Colours of what was kept (person pixels unchanged), so e.g. pink leggings
  // under a red garment aren't counted as garment.
  const changed = new Uint8Array(a.w * a.h);
  const keptPts: number[][] = [];
  for (let i = 0; i < changed.length; i++) {
    const pa = [a.px[i * 3], a.px[i * 3 + 1], a.px[i * 3 + 2]];
    changed[i] = dist(pa, [b.px[i * 3], b.px[i * 3 + 1], b.px[i * 3 + 2]]) > 40 ? 1 : 0;
    if (!changed[i] && fgA[i]) keptPts.push(pa);
  }
  const keptPal = palette(sample(keptPts, 6000), 10);

  let hem = person.top;
  let garmentRows = 0;
  for (let y = person.top; y <= person.bottom; y++) {
    let row = 0;
    let width = 0;
    for (let x = 0; x < a.w; x++) {
      const i = y * a.w + x;
      if (!fgB[i]) continue;
      width++;
      const p = px(b, x, y);
      if (changed[i] && near(p, garmentPal) && !near(p, keptPal)) row++;
    }
    if (width && row / width > 0.25) {
      hem = y;
      garmentRows++;
    }
  }
  const span = Math.max(1, person.bottom - person.top);
  const hemPos = (hem - person.top) / span;
  const determined = garmentRows / span >= MIN_GARMENT_ROWS;
  const [lo, hi] = LENGTHS[opts.expectedLength];
  return {
    expected: opts.expectedLength,
    hemPos,
    determined,
    flagged: determined && (hemPos < lo - LENGTH_TOLERANCE || hemPos > hi + LENGTH_TOLERANCE),
  };
}

// ---- helpers ----

function px(img: Img, x: number, y: number): number[] {
  const i = (y * img.w + x) * 3;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
}

function dist(p: number[], q: number[]) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function median(v: number[]) {
  const s = [...v].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
