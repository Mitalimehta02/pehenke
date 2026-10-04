import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  CLOTHES_V3_IMAGE,
  SKIN_TONE_IMAGE,
  TaskLostError,
  TaskPollTimeoutError,
  prepareImage,
  type ClothesV3Result,
  type Feature,
  type SkinToneResult,
  type TaskStatusData,
  type YouCamClient,
} from "@/lib/youcam";
import { youcamFromEnv } from "@/lib/youcam/server";
import { checkBadRender } from "@/lib/guards/badRender";
import { checkGarmentLength } from "@/lib/guards/length";
import { auditAndDecide } from "./verdict";
import {
  GARMENTS_DIR,
  IMAGES_DIR,
  PEOPLE_DIR,
  SKINTONE_DIR,
  addPending,
  cachedUpload,
  featureOf,
  fileCallLogger,
  loadCache,
  loadLedger,
  loadPending,
  rememberUpload,
  removePending,
  saveRecord,
  sha256,
  type Job,
  type PendingTask,
  type ResultRecord,
  type TryOnJob,
} from "./store";

export const POLL_TIMEOUT_MS = 5 * 60_000;

export function spikeClient(): YouCamClient {
  // Console shows task starts, charges and failures; units.log gets every call.
  return youcamFromEnv(
    fileCallLogger((e) => e.note === "start" || e.units !== 0 || typeof e.httpStatus !== "number" || e.httpStatus >= 400),
  );
}

export function capFromEnv(): number {
  return Number(process.env.SPIKE_UNIT_CAP ?? 300);
}

/**
 * Balance total, or null if the endpoint rejects our key (it's documented
 * under V1 auth) or returns no unit entries (seen live: `results: []`).
 */
export async function tryBalance(client: YouCamClient): Promise<number | null> {
  try {
    const b = await client.balance();
    return b.entries.length ? b.total : null;
  } catch {
    return null;
  }
}

// ---------------- budget ----------------

export interface Budget {
  cap: number;
  /** units recorded by the spike: successes, plus full cost for lost / unknown starts */
  recorded: number;
  /** units held back for tasks still pending */
  reserved: number;
  /** baseline - current balance, when both are known */
  balanceSpent: number | null;
  /** the larger of recorded and balanceSpent: we budget against the worse case */
  spent: number;
  balance: number | null;
}

export async function budget(client: YouCamClient): Promise<Budget> {
  const cap = capFromEnv();
  const recorded = Object.values(loadCache()).reduce((n, r) => n + r.units, 0);
  const reserved = loadPending().reduce((n, p) => n + (client.unitCost(featureOf(p.job)) ?? 0), 0);
  const balance = await tryBalance(client);
  const { baselineBalance } = loadLedger();
  const balanceSpent = balance !== null && baselineBalance !== undefined ? baselineBalance - balance : null;
  return { cap, recorded, reserved, balanceSpent, spent: Math.max(recorded, balanceSpent ?? 0), balance };
}

export function formatBudget(b: Budget) {
  return (
    `spike total ${b.spent} / ${b.cap} units` +
    (b.reserved ? ` (+${b.reserved} reserved for pending)` : "") +
    (b.balance !== null ? ` | balance ${b.balance}` : " | balance unavailable") +
    (b.balanceSpent !== null && b.balanceSpent !== b.recorded ? ` | note: balance says ${b.balanceSpent} spent, records say ${b.recorded}` : "")
  );
}

export class BudgetStop extends Error {}

// ---------------- uploads ----------------

async function uploadPrepared(client: YouCamClient, feature: Feature, dir: string, file: string, fresh = false): Promise<{ fileId: string; prepared: Uint8Array }> {
  const spec = feature === "cloth-v3" ? CLOTHES_V3_IMAGE : SKIN_TONE_IMAGE;
  const prepared = await prepareImage(readFileSync(path.join(dir, file)), file, spec);
  if (prepared.changes.length) console.log(`  prepared ${file}: ${prepared.changes.join(", ")}`);
  const hash = sha256(prepared.bytes);
  const cached = fresh ? undefined : cachedUpload(feature, hash);
  if (cached) return { fileId: cached, prepared: prepared.bytes };
  const fileId = await client.upload(feature, { bytes: prepared.bytes, fileName: prepared.fileName, contentType: prepared.contentType });
  rememberUpload(feature, hash, fileId);
  return { fileId, prepared: prepared.bytes };
}

// ---------------- execute ----------------

/**
 * Runs one paid task end to end. The task id goes to pending.json the moment
 * the task exists, before any polling, and leaves it only once the outcome is
 * recorded. Throws TaskPollTimeoutError (task stays pending) or BudgetStop.
 */
export async function executeJob(client: YouCamClient, job: Job): Promise<ResultRecord> {
  const feature = featureOf(job);
  const cost = client.unitCost(feature);
  if (cost === null) throw new BudgetStop(`Unknown unit cost for ${feature}; refusing to spend.`);
  const b = await budget(client);
  if (b.spent + b.reserved + cost > b.cap) {
    throw new BudgetStop(`Next call costs ${cost} units; ${formatBudget(b)}. That would cross the cap: stopping for your decision.`);
  }

  let body: object;
  let fileIds: ResultRecord["fileIds"];
  if (job.kind === "tryon") {
    const fresh = job.freshUpload ?? false;
    const person = await uploadPrepared(client, feature, PEOPLE_DIR, job.personFile, fresh);
    const garment = await uploadPrepared(client, feature, GARMENTS_DIR, job.garmentFile, fresh);
    body = { src_file_id: person.fileId, ref_file_id: garment.fileId, garment_category: job.category };
    fileIds = { src: person.fileId, ref: garment.fileId, fresh };
  } else {
    const person = await uploadPrepared(client, feature, PEOPLE_DIR, job.personFile);
    body = { src_file_id: person.fileId };
    fileIds = { src: person.fileId, fresh: false };
  }

  const startedAt = new Date().toISOString();
  let taskId: string;
  try {
    taskId = await client.startTask(feature, body);
  } catch (err) {
    // A failed start may still have created a paid task we can't see. If the
    // server answered with a 4xx it definitely didn't; otherwise assume the worst.
    const definite = typeof err === "object" && err && "httpStatus" in err && Number((err as { httpStatus: number }).httpStatus) < 500;
    const rec: ResultRecord = {
      job,
      status: definite ? "error" : "start_unknown",
      error: definite ? (err as { errorCode?: string }).errorCode ?? "start_failed" : "start_unknown",
      errorMessage: String((err as Error).message ?? err),
      startedAt,
      finishedAt: new Date().toISOString(),
      units: definite ? 0 : cost,
    };
    saveRecord(rec);
    if (!definite) throw new BudgetStop(`Task start for ${describe(job)} failed ambiguously (${rec.errorMessage}); counted ${cost} units as possibly spent. Stopping.`);
    return rec;
  }

  const pending: PendingTask = { job, taskId, startedAt, unitsBefore: b.balance, fileIds };
  addPending(pending);
  console.log(`  task ${taskId.slice(0, 12)}… started, saved to pending.json`);
  return pollAndRecord(client, pending, false);
}

/** Resume every pending task before anything new runs. Returns ids still running. */
export async function resumePending(client: YouCamClient): Promise<string[]> {
  const pending = loadPending();
  if (!pending.length) return [];
  console.log(`Resuming ${pending.length} pending task(s) from an earlier run…`);
  const stillRunning: string[] = [];
  for (const p of pending) {
    console.log(`- ${describe(p.job)} (task ${p.taskId.slice(0, 12)}…)`);
    try {
      report(await pollAndRecord(client, p, true));
    } catch (err) {
      if (err instanceof TaskPollTimeoutError) stillRunning.push(p.taskId);
      else throw err;
    }
  }
  return stillRunning;
}

async function pollAndRecord(client: YouCamClient, p: PendingTask, resumed: boolean): Promise<ResultRecord> {
  const feature = featureOf(p.job);
  const cost = client.unitCost(feature) ?? 0;
  const startedMs = Date.parse(p.startedAt);
  let status: TaskStatusData<ClothesV3Result | SkinToneResult>;
  try {
    status = await client.pollTask(feature, p.taskId, { timeoutMs: POLL_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof TaskLostError) {
      const rec: ResultRecord = {
        job: p.job,
        status: "lost",
        taskId: p.taskId,
        error: err.errorCode,
        errorMessage: "task no longer known to the server; units assumed spent",
        startedAt: p.startedAt,
        finishedAt: new Date().toISOString(),
        units: cost,
        resumed,
      };
      saveRecord(rec);
      removePending(p.taskId);
      return rec;
    }
    throw err; // timeout or transport error: the task stays in pending.json
  }

  const finishedAt = new Date().toISOString();
  const rec: ResultRecord = {
    job: p.job,
    status: status.task_status === "success" ? "success" : "error",
    taskId: p.taskId,
    error: status.error ?? undefined,
    errorMessage: status.error_message,
    startedAt: p.startedAt,
    finishedAt,
    latencySec: Math.round((Date.parse(finishedAt) - startedMs) / 100) / 10,
    units: status.task_status === "success" ? cost : 0,
    resumed,
    fileIds: p.fileIds,
  };

  if (rec.status === "success") {
    if (p.unitsBefore !== null) {
      const after = await tryBalance(client);
      rec.unitsBalanceDelta = after === null ? null : p.unitsBefore - after;
    }
    if (p.job.kind === "tryon") await saveTryOnOutput(client, p, status as TaskStatusData<ClothesV3Result>, rec);
    else saveSkinTone(p, status as TaskStatusData<SkinToneResult>, rec);
  }

  saveRecord(rec);
  removePending(p.taskId);
  return rec;
}

async function saveTryOnOutput(client: YouCamClient, p: PendingTask, status: TaskStatusData<ClothesV3Result>, rec: ResultRecord) {
  const job = p.job;
  if (job.kind !== "tryon") return;
  const url = status.results?.url;
  if (!url) {
    rec.errorMessage = "success without results.url";
    return;
  }
  // Result URLs expire in ~2h: download now, retrying a few times.
  let dl: { bytes: Uint8Array; contentType: string } | undefined;
  for (let i = 0; i < 3 && !dl; i++) {
    try {
      dl = await client.download(url);
    } catch (err) {
      console.warn(`  download attempt ${i + 1} failed: ${(err as Error).message}`);
    }
  }
  if (!dl) {
    rec.resultUrl = url;
    rec.errorMessage = "result download failed; resultUrl kept (valid ~2h)";
    return;
  }
  const meta = await sharp(dl.bytes).metadata();
  const ext = meta.format === "png" ? "png" : "jpg";
  const name = `${base(job.garmentFile)}__${job.person}-${job.framing}__${job.category}${job.repeat ? `__r${job.repeat}` : ""}__${job.key.slice(0, 8)}.${ext}`;
  mkdirSync(IMAGES_DIR, { recursive: true });
  const out = path.join(IMAGES_DIR, name);
  writeFileSync(out, dl.bytes);
  rec.outputPath = path.relative(process.cwd(), out).replaceAll("\\", "/");
  rec.outputWidth = meta.width;
  rec.outputHeight = meta.height;

  Object.assign(rec, await analyseOutput(job, dl.bytes));
  // render audit (one at a time, free tier) + card verdict; never blocks the run
  await auditAndDecide(rec, { callProvider: true });
}

/** Pixel guards on a try-on output: bad render (original clothes returned) and garment length. Free. */
export async function analyseOutput(job: TryOnJob, output: Uint8Array): Promise<Pick<ResultRecord, "badRender" | "lengthCheck">> {
  // Compare against exactly what we uploaded (EXIF-rotated person photo).
  const input = await prepareImage(readFileSync(path.join(PEOPLE_DIR, job.personFile)), job.personFile, CLOTHES_V3_IMAGE);
  const garment = readFileSync(path.join(GARMENTS_DIR, job.garmentFile));
  return {
    badRender: await checkBadRender(input.bytes, output, job.framing, job.labelCategory),
    lengthCheck: await checkGarmentLength({ input: input.bytes, output, garment, framing: job.framing, expectedLength: job.expectedLength }),
  };
}

function saveSkinTone(p: PendingTask, status: TaskStatusData<SkinToneResult>, rec: ResultRecord) {
  mkdirSync(SKINTONE_DIR, { recursive: true });
  const out = path.join(SKINTONE_DIR, `${base(p.job.personFile)}__${p.job.key.slice(0, 8)}.json`);
  writeFileSync(out, JSON.stringify(status.results ?? null, null, 2));
  rec.outputPath = path.relative(process.cwd(), out).replaceAll("\\", "/");
  rec.skinTone = status.results;
}

const base = (f: string) => f.replace(/\.[^.]+$/, "");

export function describe(job: Job) {
  return job.kind === "tryon"
    ? `${job.garmentFile} [${job.label}, ${job.photoType}, ${job.category}] on ${job.personFile}${job.repeat ? ` (repeat ${job.repeat}${job.freshUpload ? ", fresh upload" : ""})` : ""}`
    : `skin tone of ${job.personFile}`;
}

export function report(rec: ResultRecord) {
  const parts = [`  -> ${rec.status}`];
  if (rec.latencySec !== undefined) parts.push(`${rec.latencySec}s`);
  parts.push(`units ${rec.units}${rec.unitsBalanceDelta != null ? ` (balance delta ${rec.unitsBalanceDelta})` : ""}`);
  if (rec.error) parts.push(`error ${rec.error}${rec.errorMessage ? `: ${rec.errorMessage}` : ""}`);
  if (rec.outputPath) parts.push(rec.outputPath);
  if (rec.badRender) parts.push(`region changed ${(rec.badRender.changedPct * 100).toFixed(0)}%${rec.badRender.flagged ? " BAD-RENDER FLAG" : ""}`);
  if (rec.verdict) parts.push(`CARD: ${rec.verdict.card_verdict}${rec.verdict.block_reason ? ` (${rec.verdict.block_reason})` : ""} [audit ${rec.verdict.audit_status}]`);
  if (rec.lengthCheck) parts.push(rec.lengthCheck.determined === false ? `hem unknown (expected ${rec.lengthCheck.expected})` : `hem ${rec.lengthCheck.hemPos.toFixed(2)} (expected ${rec.lengthCheck.expected})${rec.lengthCheck.flagged ? " LENGTH FLAG" : ""}`);
  console.log(parts.join(" | "));
}
