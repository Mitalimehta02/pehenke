// Complete-the-look spike: lipstick (makeup-vto), necklace and earring (2d-vto) on our try-on output.
//
// npm run spike:look                 -> dry run: prepares inputs (free), prints the plan and worst-case cost
// npm run spike:look -- --yes        -> runs the calls (spends units; only after human approval)
// npm run spike:look -- --compare    -> free: local comparison, paste-back images and a contact sheet
//
// Rules: balance is read before and after every call; a task id is saved before polling; a
// call that already has a final result is never repeated; the run stops before exceeding
// --max-units (default 10) measured from the balance, and never passes HARD_CAP.
import "./loadEnv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp, { type Sharp } from "sharp";
import { lipShadesForGarment } from "@/lib/look/lipShade";
import { TaskLostError, TaskPollTimeoutError, YouCamApiError, type Feature, type YouCamClient } from "@/lib/youcam";
import { spikeClient } from "./runner";

// Spike-only features (not part of the app's typed client yet).
const MAKEUP = "makeup-vto" as Feature;
const NECKLACE = "2d-vto/necklace" as Feature;
const EARRING = "2d-vto/earring" as Feature;
/** units per successful result, from GET /credit/feature-cost (earring: "Single") */
const COST: Record<string, number> = { "makeup-vto": 1, "2d-vto/necklace": 1, "2d-vto/earring": 1 };
const HARD_CAP = 12;

const ROOT = process.cwd();
const OUT = path.join(ROOT, "spike-output", "look");
const INPUTS = path.join(OUT, "inputs");
const RESULTS = path.join(OUT, "results");
const RUNS = path.join(OUT, "runs.json");

/** Base image: a cached demo render (Sample model B in the ivory saree), bare neck. */
const BASE = path.join(ROOT, "spike-output", "prerender", "B-ivory-zari-silk-saree.jpg");
const BASE_GARMENT = path.join(ROOT, "spike-assets", "garments", "saree-museum-mannequin.jpg");
/** Head-and-shoulders box in the base image (1280x1600), upscaled x2 for the API. */
const CROP = { left: 316, top: 150, width: 480, height: 600 };
const CROP_SCALE = 2;

type Call = {
  id: string;
  feature: Feature;
  src: string;
  ref?: string;
  /** what the call is meant to show */
  question: string;
  /** only run if this earlier call failed */
  onlyIfFailed?: string;
  /** src is the output of this earlier call */
  srcFrom?: string;
};

type Run = {
  id: string;
  feature: string;
  src: string;
  ref?: string;
  taskId?: string;
  status: "pending" | "success" | "error" | "rejected" | "lost";
  error?: string;
  balanceBefore: number;
  balanceAfter?: number;
  charged?: number;
  output?: string;
  ms?: number;
  at: string;
};

const loadRuns = (): Record<string, Run> => (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, "utf8")) : {});
const saveRun = (r: Run) => {
  const all = loadRuns();
  all[r.id] = r;
  writeFileSync(RUNS, JSON.stringify(all, null, 2));
};

const inp = (name: string) => path.join(INPUTS, name);

/** Free, local: write every input image the calls use. */
async function prepareInputs() {
  mkdirSync(INPUTS, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  const jpg = (s: Sharp) => s.jpeg({ quality: 92 });
  await jpg(sharp(BASE)).toFile(inp("base-full.jpg"));
  await jpg(
    sharp(BASE)
      .extract(CROP)
      .resize(CROP.width * CROP_SCALE, CROP.height * CROP_SCALE, { kernel: "lanczos3" }),
  ).toFile(inp("base-crop.jpg"));
  await jpg(sharp(path.join(ROOT, "spike-assets", "people", "model1-chest.jpg"))).toFile(inp("chest.jpg"));
  await jpg(sharp(path.join(ROOT, "spike-assets", "people", "side-portrait.jpg")).resize(1400, 1400, { fit: "inside", withoutEnlargement: true })).toFile(inp("side.jpg"));
  const J = path.join(ROOT, "spike-assets", "jewellery");
  await jpg(sharp(path.join(J, "necklace-ushape.jpg"))).toFile(inp("necklace-ushape.jpg"));
  await jpg(sharp(path.join(J, "necklace-flatlay.jpg"))).toFile(inp("necklace-flatlay.jpg"));
  await jpg(sharp(path.join(J, "earrings-card.jpg"))).toFile(inp("earrings-card.jpg"));
  // one earring, front view: the left one of the pair
  await jpg(sharp(path.join(J, "earrings-pair.jpg")).extract({ left: 120, top: 0, width: 450, height: 800 })).toFile(inp("earring-single.jpg"));
  await cleanFlatlay(path.join(J, "necklace-flatlay.jpg"), inp("necklace-flatlay-clean.png"));
}

/**
 * Our own background removal for a flat-lay: pixels close to the backdrop
 * colour (median of the border) become transparent, then the item is trimmed
 * and centred on a square transparent canvas.
 */
async function cleanFlatlay(src: string, dest: string) {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ring: number[][] = [];
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) if (x < 12 || y < 12 || x >= w - 12 || y >= h - 12) ring.push([data[(y * w + x) * 3], data[(y * w + x) * 3 + 1], data[(y * w + x) * 3 + 2]]);
  const med = (k: number) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    // the cloth is blue; the chain is gold: keep pixels that are far from the backdrop and not blue-dominant
    const far = Math.hypot(r - bg[0], g - bg[1], b - bg[2]) > 90 && !(b > r && b > g);
    rgba.set([r, g, b, far ? 255 : 0], i * 4);
  }
  const item = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer({ resolveWithObject: true });
  const side = Math.round(Math.max(item.info.width, item.info.height) * 1.15);
  await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: item.data, gravity: "centre" }])
    .png()
    .toFile(dest);
}

const CALLS: Call[] = [
  { id: "L1", feature: MAKEUP, src: "base-full.jpg", question: "lipstick on the full-body output as-is (small face)" },
  { id: "L2", feature: MAKEUP, src: "base-crop.jpg", question: "lipstick on a head-and-shoulders crop of the output" },
  { id: "L3", feature: MAKEUP, src: "chest.jpg", question: "lipstick on a chest-up photo (baseline)" },
  { id: "N1", feature: NECKLACE, src: "base-full.jpg", ref: "necklace-ushape.jpg", question: "necklace on the full-body output as-is (expected: rejected)" },
  { id: "N2", feature: NECKLACE, src: "base-crop.jpg", ref: "necklace-ushape.jpg", question: "necklace on the crop, worn-shape product photo" },
  { id: "N3", feature: NECKLACE, src: "base-crop.jpg", ref: "necklace-flatlay.jpg", question: "necklace on the crop, seller-style flat-lay photo" },
  { id: "N3b", feature: NECKLACE, src: "base-crop.jpg", ref: "necklace-flatlay-clean.png", onlyIfFailed: "N3", question: "flat-lay again, background removed and centred by us" },
  // before the earring calls, so the chained result is never the one cut by the budget
  { id: "C1", feature: MAKEUP, src: "", srcFrom: "N2", question: "chain: lipstick on the necklace result (one complete look)" },
  { id: "E1", feature: EARRING, src: "base-crop.jpg", ref: "earring-single.jpg", question: "earring on the front-facing crop (expected: rejected)" },
  { id: "E2", feature: EARRING, src: "side.jpg", ref: "earring-single.jpg", question: "earring on a side-turned close-up, single earring photo" },
  { id: "E3", feature: EARRING, src: "side.jpg", ref: "earrings-card.jpg", question: "earring on the side close-up, seller-style photo of a pair on a card" },
];

function body(c: Call, srcId: string, refId: string | undefined, lipHex: string): object {
  if (c.feature === MAKEUP) {
    return {
      src_file_id: srcId,
      version: "1.0",
      effects: [
        // smoothing is applied at 50 unless told otherwise: 0 keeps the buyer's skin as it is
        { category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 },
        { category: "lip_color", shape: { name: "original" }, morphology: { fullness: 0, wrinkless: 0 }, style: { type: "full" }, palettes: [{ color: lipHex, texture: "matte", colorIntensity: 70 }] },
      ],
    };
  }
  if (c.feature === NECKLACE) {
    return {
      src_file_id: srcId,
      ref_file_ids: [refId],
      source_info: { name: srcId },
      object_infos: [{ name: refId, parameter: { necklace_need_remove_background: true, necklace_anchor_point: null, necklace_wearing_location: null, necklace_shadow_intensity: 0.5, necklace_ambient_light_intensity: 0.5 } }],
    };
  }
  return {
    src_file_id: srcId,
    ref_file_ids: [refId],
    source_info: { name: srcId },
    object_infos: [
      {
        name: refId,
        parameter: { earring_need_remove_background: true, earring_anchor_point: null, earring_wearing_location: null, earring_scale: null, earring_is_right_ear: true, earring_occluded_type: 0, earring_shadow_intensity: 0.5, earring_ambient_light_intensity: 0.5 },
      },
    ],
  };
}

/** First http(s) URL anywhere in the results (the docs show both `results.url` and `results[].download_url`). */
function findUrl(o: unknown): string | null {
  if (typeof o === "string") return /^https?:\/\//.test(o) ? o : null;
  if (o && typeof o === "object") for (const v of Object.values(o)) if (findUrl(v)) return findUrl(v);
  return null;
}

async function upload(client: YouCamClient, feature: Feature, file: string) {
  const bytes = readFileSync(file);
  const png = file.endsWith(".png");
  return client.upload(feature, { bytes, fileName: path.basename(file), contentType: png ? "image/png" : "image/jpg" });
}

async function runCalls(maxUnits: number, lipHex: string) {
  const client = spikeClient();
  const start = (await client.balance()).total;
  console.log(`\nbalance at start: ${start} units. Budget for this run: ${maxUnits} (hard cap ${HARD_CAP}).`);
  const spentBefore = Object.values(loadRuns()).reduce((n, r) => n + (r.charged ?? 0), 0);

  for (const c of CALLS) {
    const runs = loadRuns();
    const prior = runs[c.id];
    if (prior && prior.status !== "pending") {
      console.log(`${c.id}: already done (${prior.status}), not repeated`);
      continue;
    }
    if (prior?.status === "pending") {
      console.log(`${c.id}: has an unfinished task from an earlier run; resolve it before running again (task saved in runs.json)`);
      break;
    }
    if (c.onlyIfFailed && runs[c.onlyIfFailed]?.status === "success") {
      console.log(`${c.id}: skipped (${c.onlyIfFailed} worked)`);
      continue;
    }
    let srcFile = inp(c.src);
    if (c.srcFrom) {
      const from = runs[c.srcFrom];
      // chain on the necklace-on-crop result; fall back to any necklace result on the crop
      const alt = from?.status === "success" ? from : Object.values(runs).find((r) => r.feature === NECKLACE && r.status === "success" && r.src === "base-crop.jpg");
      if (!alt?.output) {
        console.log(`${c.id}: skipped (no necklace result to chain on)`);
        continue;
      }
      srcFile = alt.output;
    }

    const before = (await client.balance()).total;
    const spent = spentBefore + (start - before);
    if (spent + COST[c.feature] > Math.min(maxUnits, HARD_CAP)) {
      console.log(`${c.id}: skipped, budget reached (${spent} of ${maxUnits} units spent)`);
      continue;
    }
    console.log(`\n${c.id}: ${c.question}\n  balance before: ${before}`);
    const run: Run = { id: c.id, feature: c.feature, src: path.basename(srcFile), ref: c.ref, status: "pending", balanceBefore: before, at: new Date().toISOString() };
    const t0 = Date.now();
    try {
      const srcId = await upload(client, c.feature, srcFile);
      const refId = c.ref ? await upload(client, c.feature, inp(c.ref)) : undefined;
      // never auto-retried: a second POST could create a second paid task
      const taskId = await client.startTask(c.feature, body(c, srcId, refId, lipHex));
      run.taskId = taskId;
      saveRun(run); // before polling: an un-polled task still charges
      const st = await client.pollTask<unknown>(c.feature, taskId, { timeoutMs: 5 * 60_000 });
      if (st.task_status === "success") {
        const url = findUrl(st.results);
        if (!url) throw new Error(`success without a result url: ${JSON.stringify(st.results).slice(0, 300)}`);
        const img = await client.download(url); // result urls expire: download now
        const ext = (await sharp(img.bytes).metadata()).format === "png" ? "png" : "jpg";
        run.output = path.join(RESULTS, `${c.id}.${ext}`);
        writeFileSync(run.output, img.bytes);
        run.status = "success";
      } else {
        run.status = "error";
        run.error = `${st.error ?? "error"}${st.error_message ? `: ${st.error_message}` : ""}`;
      }
    } catch (err) {
      if (err instanceof TaskPollTimeoutError) {
        saveRun(run);
        console.log(`  still running after 5 min; task id kept in runs.json. Stopping (it may still charge).`);
        break;
      }
      run.status = err instanceof TaskLostError ? "lost" : "rejected";
      run.error = err instanceof YouCamApiError ? `${err.httpStatus} ${err.errorCode ?? ""} ${err.message}`.trim() : (err as Error).message;
    }
    run.ms = Date.now() - t0;
    run.balanceAfter = (await client.balance()).total;
    run.charged = before - run.balanceAfter;
    saveRun(run);
    console.log(`  ${run.status}${run.error ? ` (${run.error})` : ""} in ${(run.ms / 1000).toFixed(1)}s\n  balance after: ${run.balanceAfter}  => charged ${run.charged}`);
  }

  const end = (await client.balance()).total;
  const all = Object.values(loadRuns());
  console.log(`\nbalance at end: ${end}. This run: ${start - end} units. All look-spike calls so far: ${all.reduce((n, r) => n + (r.charged ?? 0), 0)} units.`);
  for (const f of [MAKEUP, NECKLACE, EARRING]) {
    const failed = all.filter((r) => r.feature === f && r.status !== "success" && r.status !== "pending");
    console.log(`  ${f}: failed or rejected calls: ${failed.length}; charged for them: ${failed.reduce((n, r) => n + (r.charged ?? 0), 0)} units${failed.length ? ` (${failed.map((r) => `${r.id}=${r.charged}`).join(", ")})` : ""}`);
  }
}

// ---------------- free, local comparison ----------------

/** Per-pixel max channel difference between two same-size images, plus where the strong changes are. */
async function diff(aFile: string, bFile: string) {
  const a = await sharp(aFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bMeta = await sharp(bFile).metadata();
  const sameSize = a.info.width === bMeta.width && a.info.height === bMeta.height;
  const b = await sharp(bFile).removeAlpha().resize(a.info.width, a.info.height, { fit: "fill" }).raw().toBuffer();
  const { width: w, height: h } = a.info;
  const d = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, strong = 0;
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(Math.abs(a.data[i * 3] - b[i * 3]), Math.abs(a.data[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a.data[i * 3 + 2] - b[i * 3 + 2]));
    d[i] = v;
    if (v > 40) {
      strong++;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { w, h, d, sameSize, outSize: `${bMeta.width}x${bMeta.height}`, strongPct: (strong / (w * h)) * 100, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
}

/** Mean difference and share of clearly changed pixels outside a box (padded). */
function outside(r: Awaited<ReturnType<typeof diff>>, box: { x0: number; y0: number; x1: number; y1: number }, pad: number) {
  let sum = 0, n = 0, changed = 0;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (x >= box.x0 - pad && x <= box.x1 + pad && y >= box.y0 - pad && y <= box.y1 + pad) continue;
      const v = r.d[y * r.w + x];
      sum += v;
      n++;
      if (v > 16) changed++;
    }
  }
  return { mean: n ? sum / n : 0, changedPct: n ? (changed / n) * 100 : 0 };
}

async function heat(r: Awaited<ReturnType<typeof diff>>, dest: string) {
  const buf = Buffer.alloc(r.w * r.h * 3);
  for (let i = 0; i < r.w * r.h; i++) {
    const v = Math.min(255, r.d[i] * 4);
    buf.set([v, v > 64 ? 0 : v, v > 64 ? 0 : v], i * 3);
  }
  await sharp(buf, { raw: { width: r.w, height: r.h, channels: 3 } }).jpeg({ quality: 85 }).toFile(dest);
}

/** Put a crop result back into the full-body base image. */
async function pasteBack(resultFile: string, dest: string) {
  const patch = await sharp(resultFile).resize(CROP.width, CROP.height, { kernel: "lanczos3", fit: "fill" }).toBuffer();
  await sharp(BASE).composite([{ input: patch, left: CROP.left, top: CROP.top }]).jpeg({ quality: 92 }).toFile(dest);
}

async function compare() {
  const runs = loadRuns();
  const cmp = path.join(OUT, "compare");
  mkdirSync(cmp, { recursive: true });
  console.log("\nLocal comparison (free). 'strong' = pixels whose colour changed by more than 40/255.");
  for (const c of CALLS) {
    const r = runs[c.id];
    if (!r?.output || r.status !== "success") continue;
    const srcFile = c.srcFrom ? Object.values(runs).find((x) => x.output && path.basename(x.output) === r.src)?.output ?? inp(r.src) : inp(r.src);
    const d = await diff(srcFile, r.output);
    await heat(d, path.join(cmp, `${c.id}-diff.jpg`));
    const box = d.box;
    const out = box ? outside(d, box, 12) : { mean: 0, changedPct: 0 };
    console.log(
      `${c.id} (${r.feature}): output ${d.outSize}, ${d.sameSize ? "same size as input" : `INPUT WAS ${d.w}x${d.h}`}; strong change on ${d.strongPct.toFixed(2)}% of pixels` +
        (box ? `, inside box x ${box.x0}-${box.x1}, y ${box.y0}-${box.y1} (${(((box.x1 - box.x0) * (box.y1 - box.y0)) / (d.w * d.h) * 100).toFixed(1)}% of the image); outside that box: mean change ${out.mean.toFixed(2)}/255, ${out.changedPct.toFixed(2)}% of pixels changed by more than 16` : ", none"),
    );
    if (r.src === "base-crop.jpg" || c.srcFrom) await pasteBack(r.output, path.join(cmp, `${c.id}-full-body.jpg`));
  }
  // contact sheet: input | result for every successful call
  const tiles: Buffer[] = [];
  for (const c of CALLS) {
    const r = runs[c.id];
    if (!r?.output || r.status !== "success") continue;
    const srcFile = c.srcFrom ? Object.values(runs).find((x) => x.output && path.basename(x.output) === r.src)?.output ?? inp(r.src) : inp(r.src);
    const label = Buffer.from(`<svg width="640" height="34"><rect width="640" height="34" fill="#000"/><text x="8" y="23" font-size="18" fill="#fff" font-family="sans-serif">${c.id}: ${c.question.replace(/&/g, "and").slice(0, 66)}</text></svg>`);
    const a = await sharp(srcFile).resize(320, 400, { fit: "contain", background: "#777" }).toBuffer();
    const b = await sharp(r.output).resize(320, 400, { fit: "contain", background: "#777" }).toBuffer();
    tiles.push(await sharp({ create: { width: 640, height: 434, channels: 3, background: "#777" } }).composite([{ input: label, left: 0, top: 0 }, { input: a, left: 0, top: 34 }, { input: b, left: 320, top: 34 }]).jpeg().toBuffer());
  }
  if (tiles.length) {
    const cols = 3, rows = Math.ceil(tiles.length / cols);
    await sharp({ create: { width: cols * 640, height: rows * 434, channels: 3, background: "#fff" } })
      .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 640, top: Math.floor(i / cols) * 434 })))
      .jpeg({ quality: 85 })
      .toFile(path.join(cmp, "sheet.jpg"));
    console.log(`\ncontact sheet (input | result): ${path.join(cmp, "sheet.jpg")}`);
  }
}

async function main() {
  const { values: args } = parseArgs({ options: { yes: { type: "boolean", default: false }, compare: { type: "boolean", default: false }, "max-units": { type: "string", default: "10" } } });
  const maxUnits = Number(args["max-units"]);
  if (!(maxUnits > 0) || maxUnits > HARD_CAP) throw new Error(`--max-units must be 1..${HARD_CAP}`);

  await prepareInputs();
  const { colours, shades } = await lipShadesForGarment(readFileSync(BASE_GARMENT));
  console.log(`garment colours: ${colours.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(", ")}`);
  console.log(`proposed lip shades: ${shades.map((s, i) => `${i + 1}. ${s.name} ${s.hex}`).join("; ")}  -> using the first`);

  if (args.compare) return compare();

  const runs = loadRuns();
  const todo = CALLS.filter((c) => !runs[c.id] || runs[c.id].status === "pending");
  console.log(`\nPlan (${todo.length} calls not yet run):`);
  for (const c of CALLS) {
    const done = runs[c.id] && runs[c.id].status !== "pending" ? ` [done: ${runs[c.id].status}]` : "";
    console.log(`  ${c.id.padEnd(3)} ${String(c.feature).padEnd(16)} ${COST[c.feature]} unit  ${c.srcFrom ? `(result of ${c.srcFrom})` : c.src}${c.ref ? ` + ${c.ref}` : ""}${c.onlyIfFailed ? `  (only if ${c.onlyIfFailed} fails)` : ""}${done}`);
  }
  const worst = todo.reduce((n, c) => n + COST[c.feature], 0);
  console.log(`\nWorst case if every call is charged: ${worst} units; the run stops before passing ${maxUnits} (hard cap ${HARD_CAP}). Inputs are in ${INPUTS}.`);
  if (!args.yes) return void console.log("Dry run: nothing spent. Add --yes to run (only after approval).");
  await runCalls(maxUnits, shades[0].hex);
  await compare();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
