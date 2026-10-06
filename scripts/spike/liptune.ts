// Lipstick intensity tuning on the cached demo base (Sample model B, ivory saree).
//
// npm run spike:liptune            -> dry run: plan and cost (1 unit per intensity not yet run)
// npm run spike:liptune -- --yes   -> run (spends units; only after approval), then compare
//
// Uses the app pipeline's own crop (face locator + headCrop) and request body. For each
// intensity it measures the colour of the pixels the API changed against the proposed
// shade, and writes a before/after sheet. A finished intensity is never run again.
import "./loadEnv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { cutCrop, headCrop } from "@/lib/look/crop";
import { findFaces, pickFace } from "@/lib/look/faceFinder";
import { lipShadesForGarment } from "@/lib/look/lipShade";
import { findUrl, LIP_TEXTURE } from "@/lib/look/service";
import type { Feature } from "@/lib/youcam";
import { spikeClient } from "./runner";

const MAKEUP = "makeup-vto" as Feature;
const INTENSITIES = [30, 40, 50];
const ROOT = process.cwd();
const OUT = path.join(ROOT, "spike-output", "look", "liptune");
const RUNS = path.join(OUT, "runs.json");
const BASE = path.join(ROOT, "spike-output", "prerender", "B-ivory-zari-silk-saree.jpg");
const GARMENT = path.join(ROOT, "spike-assets", "garments", "saree-museum-mannequin.jpg");

type Run = { intensity: number; taskId?: string; status: "pending" | "success" | "error"; error?: string; balanceBefore: number; balanceAfter?: number; charged?: number; output?: string };
const load = (): Record<string, Run> => (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, "utf8")) : {});
const save = (r: Run) => {
  const all = load();
  all[String(r.intensity)] = r;
  writeFileSync(RUNS, JSON.stringify(all, null, 2));
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

async function measure(before: Buffer, afterFile: string, target: string) {
  const a = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(afterFile).removeAlpha().resize(a.info.width, a.info.height, { fit: "fill" }).raw().toBuffer();
  const t = rgb(target);
  let n = 0;
  const sum = [0, 0, 0];
  const was = [0, 0, 0];
  for (let i = 0; i < a.data.length; i += 3) {
    const d = Math.max(Math.abs(a.data[i] - b[i]), Math.abs(a.data[i + 1] - b[i + 1]), Math.abs(a.data[i + 2] - b[i + 2]));
    if (d <= 12) continue; // the lip area the API painted
    n++;
    for (let k = 0; k < 3; k++) {
      sum[k] += b[i + k];
      was[k] += a.data[i + k];
    }
  }
  const mean = sum.map((v) => Math.round(v / Math.max(1, n)));
  const natural = was.map((v) => Math.round(v / Math.max(1, n)));
  const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return { pixels: n, lipHex: hex(mean), naturalHex: hex(natural), distance: Math.round(Math.hypot(mean[0] - t[0], mean[1] - t[1], mean[2] - t[2])) };
}

async function main() {
  const { values: args } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  mkdirSync(OUT, { recursive: true });
  const base = readFileSync(BASE);
  const picked = pickFace(await findFaces(base));
  if ("problem" in picked) throw new Error(`no usable face in the base image: ${picked.problem}`);
  const meta = await sharp(base).metadata();
  const box = headCrop(picked.face, meta.width!, meta.height!);
  if (!box) throw new Error("no head-and-shoulders crop");
  const crop = await cutCrop(base, box);
  writeFileSync(path.join(OUT, "crop.png"), crop);
  const shade = (await lipShadesForGarment(readFileSync(GARMENT))).shades[0];
  console.log(`base crop ${JSON.stringify(box)}; proposed shade: ${shade.name} ${shade.hex}; texture ${LIP_TEXTURE}`);

  const todo = INTENSITIES.filter((i) => load()[String(i)]?.status !== "success");
  console.log(`intensities to run: ${todo.join(", ") || "none"}  ->  worst case ${todo.length} unit(s) (1 each, charged only on success)`);
  if (todo.length && !args.yes) return void console.log("Dry run: nothing spent. Add --yes to run (only after approval).");

  if (todo.length) {
    const client = spikeClient();
    const start = (await client.balance()).total;
    for (const intensity of todo) {
      const before = (await client.balance()).total;
      if (start - before >= INTENSITIES.length) throw new Error("budget for this tuning reached");
      const run: Run = { intensity, status: "pending", balanceBefore: before };
      const srcId = await client.upload(MAKEUP, { bytes: crop, fileName: "crop.png", contentType: "image/png" });
      const taskId = await client.startTask(MAKEUP, {
        src_file_id: srcId,
        version: "1.0",
        effects: [
          { category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 },
          { category: "lip_color", shape: { name: "original" }, morphology: { fullness: 0, wrinkless: 0 }, style: { type: "full" }, palettes: [{ color: shade.hex, texture: LIP_TEXTURE, colorIntensity: intensity }] },
        ],
      });
      run.taskId = taskId;
      save(run); // before polling
      const st = await client.pollTask<unknown>(MAKEUP, taskId, { timeoutMs: 5 * 60_000 });
      if (st.task_status === "success" && findUrl(st.results)) {
        const img = await client.download(findUrl(st.results)!);
        run.output = path.join(OUT, `intensity-${intensity}.png`);
        writeFileSync(run.output, img.bytes);
        run.status = "success";
      } else {
        run.status = "error";
        run.error = String(st.error ?? "error");
      }
      run.balanceAfter = (await client.balance()).total;
      run.charged = before - run.balanceAfter;
      save(run);
      console.log(`intensity ${intensity}: ${run.status}${run.error ? ` (${run.error})` : ""}; balance ${before} -> ${run.balanceAfter} (charged ${run.charged})`);
    }
    console.log(`balance ${start} -> ${(await client.balance()).total}`);
  }

  // compare (free)
  const runs = load();
  const rows: Array<{ intensity: number; pixels: number; lipHex: string; naturalHex: string; distance: number }> = [];
  for (const i of INTENSITIES) {
    const r = runs[String(i)];
    if (r?.status === "success" && r.output) rows.push({ intensity: i, ...(await measure(crop, r.output, shade.hex)) });
  }
  console.log(`\nproposed shade ${shade.hex}. Painted lip colour (mean of the pixels the API changed) and its distance from the proposed shade (0-441, lower is closer):`);
  for (const r of rows) console.log(`  intensity ${r.intensity}: ${r.lipHex}  distance ${r.distance}  (${r.pixels} px; natural lip there was ${r.naturalHex})`);
  if (!rows.length) return;
  const best = [...rows].sort((a, b) => a.distance - b.distance)[0];
  console.log(`closest to the proposed shade: intensity ${best.intensity}`);

  // sheet: mouth area before | each intensity, with the target swatch
  const m = await sharp(crop).metadata();
  const mouth = { left: Math.round(m.width! * 0.3), top: Math.round(m.height! * 0.2), width: Math.round(m.width! * 0.4), height: Math.round(m.height! * 0.28) };
  const tile = async (file: Buffer | string, label: string) => {
    const lab = Buffer.from(`<svg width="400" height="30"><rect width="400" height="30" fill="#000"/><text x="6" y="21" font-size="16" fill="#fff" font-family="sans-serif">${label}</text></svg>`);
    const img = await sharp(await sharp(file).extract(mouth).toBuffer()).resize(400, 280, { fit: "cover" }).toBuffer();
    return sharp({ create: { width: 400, height: 310, channels: 3, background: "#777" } }).composite([{ input: lab, left: 0, top: 0 }, { input: img, left: 0, top: 30 }]).jpeg({ quality: 92 }).toBuffer();
  };
  const tiles = [await tile(crop, "before (try-on, no lip colour)")];
  for (const r of rows) tiles.push(await tile(runs[String(r.intensity)].output!, `intensity ${r.intensity}: ${r.lipHex}, distance ${r.distance}`));
  const swatch = await sharp({ create: { width: 400, height: 310, channels: 3, background: shade.hex } })
    .composite([{ input: Buffer.from(`<svg width="400" height="30"><rect width="400" height="30" fill="#000"/><text x="6" y="21" font-size="16" fill="#fff" font-family="sans-serif">proposed shade ${shade.hex} (${shade.name})</text></svg>`), left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
  tiles.push(swatch);
  const sheet = path.join(OUT, "sheet.jpg");
  await sharp({ create: { width: 400 * tiles.length, height: 310, channels: 3, background: "#fff" } })
    .composite(tiles.map((t, i) => ({ input: t, left: i * 400, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(sheet);
  console.log(`sheet: ${sheet}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
