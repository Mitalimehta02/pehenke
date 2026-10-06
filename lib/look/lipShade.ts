import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";

/**
 * Lip shades that suit a garment, from the garment photo alone (free: no API
 * call). Two steps:
 *   1. dominantColours(): the garment's main colours, ignoring the backdrop.
 *   2. proposeLipShades(): simple colour rules -> two wearable lip shades.
 * It doesn't know the buyer's skin tone (that analysis costs 20 units), so
 * shades stay in a wearable range (reds, corals, roses, berries, nudes) and
 * the buyer picks.
 */

export interface DominantColour {
  hex: string;
  /** share of the garment's pixels, 0..1 */
  share: number;
  /** hue 0..360 (meaningless when neutral), saturation and lightness 0..1 */
  h: number;
  s: number;
  l: number;
  /** ivory, gold-beige, grey, black, white: too little colour to drive the choice */
  neutral: boolean;
}

export interface LipShade {
  hex: string;
  name: string;
  why: string;
}

const SIZE = 64;
const HUE_BINS = 12;

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Chroma 0..1: how far a colour is from grey. Unlike HSL saturation it stays low for pale colours such as ivory. */
export const chroma = (r: number, g: number, b: number) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * The garment's main colours, largest first. The backdrop is estimated from
 * the image border and pixels close to it are ignored; the rest are grouped
 * into 12 hue families plus one neutral group.
 */
export async function dominantColours(bytes: Uint8Array, max = 3): Promise<DominantColour[]> {
  const { data } = await withImageSlot(() =>
    sharp(bytes).rotate().removeAlpha().resize(SIZE, SIZE, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true }),
  );
  const px = (x: number, y: number) => {
    const i = (y * SIZE + x) * 3;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  // backdrop = median colour of a 4 px border ring
  const ring: Array<readonly [number, number, number]> = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (x < 4 || y < 4 || x >= SIZE - 4 || y >= SIZE - 4) ring.push(px(x, y));
  const med = (k: 0 | 1 | 2) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = [med(0), med(1), med(2)];

  type Bin = { n: number; r: number; g: number; b: number };
  const bins: Bin[] = Array.from({ length: HUE_BINS + 1 }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = px(x, y);
      if (Math.hypot(r - bg[0], g - bg[1], b - bg[2]) < 42) continue; // backdrop
      const { h, l } = rgbToHsl(r, g, b);
      const neutral = chroma(r, g, b) < 0.16 || l < 0.1 || l > 0.92;
      const bin = bins[neutral ? HUE_BINS : Math.floor(((h + 15) % 360) / 30)];
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      total++;
    }
  }
  if (!total) return [];
  return bins
    .map((bin, i) => ({ bin, neutral: i === HUE_BINS }))
    .filter(({ bin }) => bin.n / total >= 0.05)
    .sort((a, b) => b.bin.n - a.bin.n)
    .slice(0, max)
    .map(({ bin, neutral }) => {
      const [r, g, b] = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
      return { hex: hex(r, g, b), share: Math.round((bin.n / total) * 100) / 100, ...rgbToHsl(r, g, b), neutral };
    });
}

type Family = "red_pink" | "orange_gold" | "green" | "blue" | "purple" | "neutral";

function family(c: DominantColour | undefined): Family {
  if (!c || c.neutral) return "neutral";
  const h = c.h;
  // pale gold / beige / cream counts as neutral: it goes with any lip colour
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16));
  if (h >= 20 && h < 70 && c.l > 0.6 && chroma(r, g, b) < 0.35) return "neutral";
  if (h >= 330 || h < 20) return "red_pink";
  if (h < 70) return "orange_gold";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  return "purple";
}

/** [hue, saturation, lightness, name, why] for the first and second shade of each garment colour family */
const RULES: Record<Family, [Shade, Shade]> = {
  red_pink: [
    [355, 0.72, 0.4, "Tonal red", "picks up the garment's red or pink"],
    [8, 0.42, 0.56, "Rose nude", "quiet, lets a red or pink garment lead"],
  ],
  orange_gold: [
    [8, 0.7, 0.46, "Warm coral red", "warm like the garment's orange and gold"],
    [16, 0.45, 0.5, "Terracotta nude", "earthy, close to the garment's warmth"],
  ],
  green: [
    [345, 0.62, 0.48, "Rose pink", "pink sits opposite green, so both stand out"],
    [335, 0.55, 0.36, "Berry", "a deeper contrast to green"],
  ],
  blue: [
    [10, 0.7, 0.54, "Coral", "warm coral balances a cool blue"],
    [350, 0.5, 0.5, "Soft rose", "gentle next to blue"],
  ],
  purple: [
    [330, 0.55, 0.36, "Plum berry", "stays in the garment's purple family"],
    [345, 0.36, 0.56, "Mauve nude", "quiet, lets the purple lead"],
  ],
  neutral: [
    [355, 0.75, 0.42, "Classic red", "a neutral garment (ivory, gold, black, white) carries a bold lip"],
    [8, 0.42, 0.56, "Rose nude", "soft, for an understated look"],
  ],
};
type Shade = [number, number, number, string, string];

/**
 * Two lip shades for a garment's dominant colours. The first chromatic colour
 * with a real share decides; deep garments get a slightly deeper lip, pale
 * garments a slightly lighter one.
 */
export function proposeLipShades(colours: DominantColour[]): LipShade[] {
  const lead = colours.find((c) => family(c) !== "neutral" && c.share >= 0.15) ?? colours[0];
  const fam = family(lead);
  const depth = lead ? (lead.l < 0.35 ? -0.04 : lead.l > 0.7 ? 0.04 : 0) : 0;
  return RULES[fam].map(([h, s, l, name, why]) => ({ hex: hslToHex(h, s, Math.min(0.62, Math.max(0.3, l + depth))), name, why }));
}

export async function lipShadesForGarment(bytes: Uint8Array): Promise<{ colours: DominantColour[]; shades: LipShade[] }> {
  const colours = await dominantColours(bytes);
  return { colours, shades: proposeLipShades(colours) };
}
