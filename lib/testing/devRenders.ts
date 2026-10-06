import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { STORE_MAX_SIDE, sha256 } from "../storage/blobs";

/**
 * Local development only (YOUCAM_FAKE=1): let the fake renderer return a real
 * render from the spike when one exists for this (garment, person), so local
 * previews look real and cost no units. Matches the uploaded (normalised)
 * bytes back to spike-assets files by re-normalising those files the same way
 * storeImage does.
 */
const PRERENDER_PERSON: Record<string, string> = { "model1-full.jpg": "A", "model3-full.jpg": "B" };
const PRERENDER_GARMENT: Record<string, string> = {
  "ghagra-museum-mannequin.jpg": "mustard-and-maroon-ghagra-set",
  "saree-museum-mannequin.jpg": "ivory-zari-silk-saree",
  "lehenga-worn.jpg": "sage-and-pink-lehenga-with-dupatta",
  "kurti-green-worn.jpg": "green-printed-kurti",
};

export async function spikeRenderLookup(): Promise<(src: Uint8Array, ref: Uint8Array) => Promise<Buffer | null>> {
  const root = process.cwd();
  const cachePath = path.join(/*turbopackIgnore: true*/ root, "spike-output", "cache.json");
  if (!existsSync(cachePath)) return async () => null;

  const byHash = new Map<string, string>();
  for (const dir of ["garments", "people"]) {
    const d = path.join(/*turbopackIgnore: true*/ root, "spike-assets", dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /\.(jpe?g|png)$/i.test(x))) {
      const norm = await sharp(readFileSync(path.join(d, f)))
        .rotate()
        .resize(STORE_MAX_SIDE, STORE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      byHash.set(sha256(norm), f);
    }
  }
  type Rec = { status: string; outputPath?: string; job: { kind: string; garmentFile?: string; personFile?: string; category?: string; labelCategory?: string; repeat?: number } };
  const recs = Object.values(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Rec>).filter(
    (r) => r.status === "success" && r.outputPath && r.job.kind === "tryon" && !r.job.repeat && r.job.category === r.job.labelCategory,
  );

  return async (src, ref) => {
    const person = byHash.get(sha256(src));
    const garment = byHash.get(sha256(ref));
    const hit = recs.find((r) => r.job.personFile === person && r.job.garmentFile === garment);
    if (hit && existsSync(path.join(/*turbopackIgnore: true*/ root, hit.outputPath!))) return readFileSync(path.join(/*turbopackIgnore: true*/ root, hit.outputPath!));
    // the demo's own pre-renders (sample model x demo garment), saved by scripts/prerender.ts
    const pre = person && garment && PRERENDER_PERSON[person] && PRERENDER_GARMENT[garment] ? path.join(/*turbopackIgnore: true*/ root, "spike-output", "prerender", `${PRERENDER_PERSON[person]}-${PRERENDER_GARMENT[garment]}.jpg`) : null;
    return pre && existsSync(pre) ? readFileSync(pre) : null;
  };
}

/**
 * Local development only (YOUCAM_FAKE=1): a rough stand-in for the look features, so the
 * local flow shows the seller's actual jewellery photo and the chosen lip colour instead
 * of test rectangles. Positions assume the pipeline's head-and-shoulders crop (face centre
 * at 50% / 28%, face about 29% of the width). Not a simulation of the real API's quality.
 */
export async function devLookRender(feature: string, crop: Uint8Array, ref: Uint8Array | null, body: Record<string, unknown>): Promise<Buffer | null> {
  const meta = await sharp(crop).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const s = 0.294 * w; // face size
  const cy = 0.282 * h;
  if (feature === "makeup-vto") {
    const effects = (body.effects ?? []) as Array<{ category?: string; palettes?: Array<{ color?: string; colorIntensity?: number }> }>;
    const lip = effects.find((e) => e.category === "lip_color")?.palettes?.[0];
    if (!lip?.color) return null;
    const lw = Math.round(0.36 * s);
    const lh = Math.round(0.13 * s);
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="${lh}"><ellipse cx="${lw / 2}" cy="${lh / 2}" rx="${lw / 2}" ry="${lh / 2}" fill="${lip.color}" fill-opacity="${Math.min(0.9, (lip.colorIntensity ?? 50) / 70)}"/></svg>`,
    );
    return sharp(crop).removeAlpha().composite([{ input: svg, left: Math.round(w / 2 - lw / 2), top: Math.round(cy + 0.3 * s) }]).png().toBuffer();
  }
  if (!ref) return null;
  const item = await cutOut(ref);
  if (feature === "2d-vto/necklace") {
    const nw = Math.round(0.95 * s);
    const piece = await sharp(item).resize(nw, null).png().toBuffer();
    return sharp(crop).removeAlpha().composite([{ input: piece, left: Math.round(w / 2 - nw / 2), top: Math.round(cy + 0.72 * s) }]).png().toBuffer();
  }
  const eh = Math.round(0.5 * s);
  const piece = await sharp(item).resize(null, eh).png().toBuffer();
  const pw = (await sharp(piece).metadata()).width!;
  const top = Math.round(cy + 0.18 * s);
  return sharp(crop)
    .removeAlpha()
    .composite([
      { input: piece, left: Math.round(w / 2 - 0.5 * s - pw / 2), top },
      { input: piece, left: Math.round(w / 2 + 0.5 * s - pw / 2), top },
    ])
    .png()
    .toBuffer();
}

/** Product photo with its backdrop made transparent (same colour-distance idea as the photo gate), trimmed. */
async function cutOut(photo: Uint8Array): Promise<Buffer> {
  const { data, info } = await sharp(photo).rotate().removeAlpha().resize(600, 600, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ycc = (r: number, g: number, b: number) => [0.299 * r + 0.587 * g + 0.114 * b, -0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
  const ring: number[][] = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (x < 8 || y < 8 || x >= w - 8 || y >= h - 8) ring.push([data[(y * w + x) * 3], data[(y * w + x) * 3 + 1], data[(y * w + x) * 3 + 2]]);
  const med = (k: number) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = ycc(med(0), med(1), med(2));
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = ycc(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    const far = Math.hypot(0.3 * (c[0] - bg[0]), c[1] - bg[1], c[2] - bg[2]) > 22;
    rgba.set([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], far ? 255 : 0], i * 4);
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer();
}
