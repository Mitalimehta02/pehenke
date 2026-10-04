import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallLogEntry, Feature, GarmentCategory } from "@/lib/youcam";
import type { RenderAudit } from "@/lib/audit/types";
import type { GarmentLength, LengthResult } from "./guards";

export const ROOT = process.cwd();
// Overridable so tests never touch the real spike state.
export const ASSETS = process.env.SPIKE_ASSETS_DIR ?? path.join(ROOT, "spike-assets");
export const GARMENTS_DIR = path.join(ASSETS, "garments");
export const PEOPLE_DIR = path.join(ASSETS, "people");
export const GARMENTS_CSV = path.join(ASSETS, "garments.csv");
export const OUT = process.env.SPIKE_OUT_DIR ?? path.join(ROOT, "spike-output");
export const IMAGES_DIR = path.join(OUT, "images");
export const SKINTONE_DIR = path.join(OUT, "skintone");

const CACHE = path.join(OUT, "cache.json");
const PENDING = path.join(OUT, "pending.json");
const UPLOADS = path.join(OUT, "uploads.json");
const LEDGER = path.join(OUT, "ledger.json");
const UNITS_LOG = path.join(OUT, "units.log");

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Write-then-rename so a crash mid-write never leaves a torn file. */
function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

// ---------- jobs & records ----------

export type Framing = "full" | "chest" | "unknown";
export type PhotoType = "flatlay" | "hanger" | "mannequin" | "worn";

export interface TryOnJob {
  kind: "tryon";
  key: string;
  garmentFile: string;
  garmentHash: string;
  label: string;
  labelCategory: GarmentCategory;
  /** what we send; differs from labelCategory only for the "auto" comparison runs */
  category: GarmentCategory;
  photoType: PhotoType;
  /** expected hem length for the length guard */
  expectedLength?: GarmentLength;
  personFile: string;
  personHash: string;
  person: string;
  framing: Framing;
  /** repeatability runs: 1..N (absent for the original render) */
  repeat?: number;
}

export interface SkinToneJob {
  kind: "skintone";
  key: string;
  personFile: string;
  personHash: string;
  person: string;
  framing: Framing;
}

export type Job = TryOnJob | SkinToneJob;

export const featureOf = (job: Job): Feature => (job.kind === "tryon" ? "cloth-v3" : "skin-tone-analysis");

export type RecordStatus = "success" | "error" | "lost" | "start_unknown";

export interface ResultRecord {
  job: Job;
  status: RecordStatus;
  taskId?: string;
  error?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
  latencySec?: number;
  /** from the feature-cost table; 0 on error; assumed full cost when lost/unknown */
  units: number;
  unitsBalanceDelta?: number | null;
  resumed?: boolean;
  outputPath?: string;
  outputWidth?: number;
  outputHeight?: number;
  /** kept only if the download failed (valid ~2h) */
  resultUrl?: string;
  badRender?: { flagged: boolean; changedPct: number; aspectChanged: boolean };
  /** garment length guard (full-body framing only) */
  lengthCheck?: LengthResult;
  /** vision-model render audit (spike:audit) */
  audit?: { provider: string; path: string; result: RenderAudit };
  skinTone?: unknown;
}

export const loadCache = () => readJson<Record<string, ResultRecord>>(CACHE, {});
export function saveRecord(rec: ResultRecord) {
  const cache = loadCache();
  cache[rec.job.key] = rec;
  writeJson(CACHE, cache);
}

// ---------- pending (paid tasks we must not lose) ----------

export interface PendingTask {
  job: Job;
  taskId: string;
  startedAt: string;
  unitsBefore: number | null;
}

export const loadPending = () => readJson<PendingTask[]>(PENDING, []);
export function addPending(p: PendingTask) {
  writeJson(PENDING, [...loadPending().filter((x) => x.taskId !== p.taskId), p]);
}
export function removePending(taskId: string) {
  writeJson(PENDING, loadPending().filter((x) => x.taskId !== taskId));
}

// ---------- uploads (file_ids live 24h; reuse for 20h) ----------

const UPLOAD_TTL_MS = 20 * 3600_000;

export function cachedUpload(feature: Feature, hash: string): string | undefined {
  const u = readJson<Record<string, { fileId: string; at: string }>>(UPLOADS, {})[`${feature}:${hash}`];
  return u && Date.now() - Date.parse(u.at) < UPLOAD_TTL_MS ? u.fileId : undefined;
}
export function rememberUpload(feature: Feature, hash: string, fileId: string) {
  const all = readJson<Record<string, { fileId: string; at: string }>>(UPLOADS, {});
  all[`${feature}:${hash}`] = { fileId, at: new Date().toISOString() };
  writeJson(UPLOADS, all);
}

// ---------- ledger (budget baseline) ----------

export interface Ledger {
  /** unit balance before the spike spent anything (if the balance endpoint works) */
  baselineBalance?: number;
  baselineAt?: string;
}
export const loadLedger = () => readJson<Ledger>(LEDGER, {});
export const saveLedger = (l: Ledger) => writeJson(LEDGER, l);

// ---------- units log ----------

export function fileCallLogger(echo: (e: CallLogEntry) => boolean) {
  mkdirSync(OUT, { recursive: true });
  return (e: CallLogEntry) => {
    appendFileSync(UNITS_LOG, JSON.stringify(e) + "\n");
    if (echo(e)) {
      console.log(`  [youcam] ${e.method} ${e.path} -> ${e.httpStatus} ${e.durationMs}ms units=${e.units ?? "?"}${e.note ? ` (${e.note})` : ""}`);
    }
  };
}
