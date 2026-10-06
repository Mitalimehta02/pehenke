import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";

/**
 * Jewellery photo gate (free pixel rules, once per photo). The try-on API uses
 * the product photo as given and does not reshape it (SPIKE.md):
 *  - earring: ONE earring from the front on a plain background. A pair photo
 *    gets a suggested crop to one earring for the seller to confirm.
 *  - necklace: laid in its worn U shape on a plain background (a coiled or
 *    closed chain is drawn coiled).
 */

export type AccessoryProblem = "too_small" | "busy_background" | "not_found" | "cut_off" | "several_items" | "pair" | "not_worn_shape";

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AccessoryGateResult {
  status: "approved" | "rejected" | "needs_review";
  problems: AccessoryProblem[];
  /** earring pair: crop to one earring (pixels of the checked image), for the seller to confirm */
  cropSuggestion?: PixelBox;
  by: "rules";
  /** measurements behind the decision (for calibration and support) */
  seen: Record<string, number>;
}

const MIN_SIDE = 300;
const GRID = 128;
/**
 * A pixel belongs to the item when its colour is this far from the backdrop's. Brightness
 * counts for less than hue, so soft shadows and uneven light on a plain backdrop stay
 * backdrop (calibrated on the spike's jewellery photos).
 */
const FG_DIST = 22;
const LUMA_WEIGHT = 0.3;
const ycc = (r: number, g: number, b: number) => [0.299 * r + 0.587 * g + 0.114 * b, -0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
/** share of border pixels that may differ from the backdrop colour before the backdrop counts as busy */
const BUSY_BORDER = 0.3;

interface Mask {
  w: number;
  h: number;
  fg: Uint8Array;
  borderOff: number;
  fgShare: number;
}

async function mask(bytes: Uint8Array): Promise<Mask> {
  const { data, info } = await sharp(bytes).rotate().removeAlpha().resize(GRID, GRID, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const at = (x: number, y: number) => [data[(y * w + x) * 3], data[(y * w + x) * 3 + 1], data[(y * w + x) * 3 + 2]];
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  const ring: number[][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < m || y < m || x >= w - m || y >= h - m) ring.push(at(x, y));
  const med = (k: number) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = ycc(med(0), med(1), med(2));
  const far = (p: number[]) => {
    const c = ycc(p[0], p[1], p[2]);
    return Math.hypot(LUMA_WEIGHT * (c[0] - bg[0]), c[1] - bg[1], c[2] - bg[2]) > FG_DIST;
  };
  const raw = new Uint8Array(w * h);
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (far(at(x, y))) (raw[y * w + x] = 1), n++;
  // close small gaps (thin chains, stones) so one item is one blob
  const fg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) if (raw[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]) on = 1;
      fg[y * w + x] = on;
    }
  }
  return { w, h, fg, borderOff: ring.filter(far).length / ring.length, fgShare: n / (w * h) };
}

interface Blob {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function blobs({ w, h, fg }: Mask): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!fg[start] || seen[start]) continue;
    const b: Blob = { area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      b.area++;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && fg[j] && !seen[j]) (seen[j] = 1), stack.push(j);
      }
    }
    out.push(b);
  }
  return out.sort((a, b) => b.area - a.area);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function checkAccessoryPhoto(p: { bytes: Uint8Array; type: "earring" | "necklace" }): Promise<AccessoryGateResult> {
  return withImageSlot(async () => {
    const meta = await sharp(p.bytes).metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const W = rotated ? meta.height! : meta.width!;
    const H = rotated ? meta.width! : meta.height!;
    const reject = (problems: AccessoryProblem[], seen: Record<string, number> = {}): AccessoryGateResult => ({ status: "rejected", problems, by: "rules", seen });
    if (Math.min(W, H) < MIN_SIDE) return reject(["too_small"], { width: W, height: H });

    const m = await mask(p.bytes);
    const seen: Record<string, number> = { borderOff: r2(m.borderOff), fgShare: r2(m.fgShare) };
    if (m.borderOff > BUSY_BORDER) return reject(["busy_background"], seen);
    if (m.fgShare < 0.005) return reject(["not_found"], seen);

    const all = blobs(m);
    const main = all.filter((b) => b.area >= 0.2 * all[0].area);
    seen.items = main.length;
    const touches = (b: Blob) => [b.x0 <= 0, b.y0 <= 0, b.x1 >= m.w - 1, b.y1 >= m.h - 1].filter(Boolean).length;

    if (p.type === "earring") {
      if (main.length === 2) {
        const [a, b] = [...main].sort((p1, p2) => p1.x0 + p1.x1 - (p2.x0 + p2.x1));
        const acx = (a.x0 + a.x1) / 2;
        const bcx = (b.x0 + b.x1) / 2;
        // side by side: centres well apart, and about the same size (a real pair)
        const apart = bcx - acx > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && Math.min(a.area, b.area) > 0.5 * Math.max(a.area, b.area);
        if (apart) {
          // suggest the left earring: cut at the emptiest column between the two, with a margin elsewhere
          let cut = Math.round((acx + bcx) / 2);
          let fewest = Infinity;
          for (let x = Math.ceil(acx); x <= Math.floor(bcx); x++) {
            let n = 0;
            for (let y = 0; y < m.h; y++) n += m.fg[y * m.w + x];
            if (n < fewest) (fewest = n), (cut = x);
          }
          const k = W / m.w;
          const padX = Math.round((a.x1 - a.x0 + 1) * 0.18);
          const padY = Math.round((a.y1 - a.y0 + 1) * 0.12);
          const left = Math.max(0, a.x0 - padX);
          const top = Math.max(0, a.y0 - padY);
          const right = Math.min(cut, a.x1 + padX);
          const bottom = Math.min(m.h - 1, a.y1 + padY);
          return {
            status: "needs_review",
            problems: ["pair"],
            by: "rules",
            seen,
            cropSuggestion: { left: Math.round(left * k), top: Math.round(top * k), width: Math.round((right - left + 1) * k), height: Math.round((bottom - top + 1) * k) },
          };
        }
      }
      if (main.length > 1) return reject(["several_items"], seen);
      // an earring hangs: the hook may touch the top edge, but not two edges
      if (touches(main[0]) >= 2) return reject(["cut_off"], seen);
      return { status: "approved", problems: [], by: "rules", seen };
    }

    // necklace: everything found counts as the one item
    const x0 = Math.min(...main.map((b) => b.x0));
    const x1 = Math.max(...main.map((b) => b.x1));
    const y0 = Math.min(...main.map((b) => b.y0));
    const y1 = Math.max(...main.map((b) => b.y1));
    const cutOff = x0 <= 0 || x1 >= m.w - 1 || y1 >= m.h - 1;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const share = (fx0: number, fx1: number, fy0: number, fy1: number) => {
      let n = 0;
      let on = 0;
      for (let y = y0 + Math.floor(bh * fy0); y < y0 + Math.ceil(bh * fy1); y++) {
        for (let x = x0 + Math.floor(bw * fx0); x < x0 + Math.ceil(bw * fx1); x++) {
          n++;
          on += m.fg[y * m.w + x];
        }
      }
      return n ? on / n : 0;
    };
    // a worn U: the two ends reach the top at the sides, the top middle is open, the bottom middle is filled
    const topMiddle = share(0.3, 0.7, 0, 0.35);
    const topLeft = share(0, 0.25, 0, 0.35);
    const topRight = share(0.75, 1, 0, 0.35);
    const bottomMiddle = share(0.3, 0.7, 0.6, 1);
    Object.assign(seen, { topMiddle: r2(topMiddle), topLeft: r2(topLeft), topRight: r2(topRight), bottomMiddle: r2(bottomMiddle), widthShare: r2(bw / m.w) });
    const uShape = topMiddle < 0.06 && topLeft > 0.08 && topRight > 0.08 && bottomMiddle > 0.08;
    const problems: AccessoryProblem[] = [...(uShape ? [] : (["not_worn_shape"] as const)), ...(cutOff ? (["cut_off"] as const) : [])];
    if (problems.length) return reject(problems, seen);
    return { status: "approved", problems: [], by: "rules", seen };
  });
}

/** Cut the suggested crop (or any box) out of a photo. */
export async function cropPhoto(bytes: Uint8Array, box: PixelBox): Promise<Buffer> {
  return withImageSlot(() => sharp(bytes).rotate().extract(box).jpeg({ quality: 92 }).toBuffer());
}
