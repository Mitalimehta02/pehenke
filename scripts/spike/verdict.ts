import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditorFromEnv, type RenderAuditor } from "@/lib/audit";
import { decideCardVerdict } from "@/lib/verdict/cardVerdict";
import { GARMENTS_DIR, OUT, PEOPLE_DIR, type ResultRecord } from "./store";

const AUDITS_DIR = path.join(OUT, "audits");
const mime = (f: string) => (/\.png$/i.test(f) ? "image/png" : "image/jpeg") as "image/png" | "image/jpeg";

let auditor: RenderAuditor | null | undefined;
function getAuditor(): RenderAuditor | null {
  if (auditor === undefined) {
    try {
      auditor = auditorFromEnv() ?? null;
    } catch {
      auditor = null;
    }
  }
  return auditor;
}

/** Tests only: replace the configured auditor (null = not configured). */
export function setAuditorForTests(a: RenderAuditor | null) {
  auditor = a;
}

export const auditPath = (outputPath: string) => path.join(AUDITS_DIR, `${path.basename(outputPath, path.extname(outputPath))}.json`);

/**
 * Fills rec.audit (from the cached audit file, or a fresh audit unless
 * `callProvider` is false) and rec.verdict. Never throws for audit problems:
 * an unavailable audit falls back to pixel checks only.
 */
export async function auditAndDecide(rec: ResultRecord, opts: { callProvider: boolean; redo?: boolean }): Promise<void> {
  if (rec.job.kind !== "tryon" || rec.status !== "success" || !rec.outputPath) return;
  const job = rec.job;
  const file = auditPath(rec.outputPath);

  if (existsSync(file) && !opts.redo) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    rec.audit = { status: "ok", provider: saved.provider, path: rel(file), result: saved.audit };
  } else if (!opts.callProvider) {
    rec.audit ??= { status: getAuditor() ? "unavailable" : "not_configured" };
  } else {
    const a = getAuditor();
    if (!a) {
      rec.audit = { status: "not_configured" };
    } else {
      const started = Date.now();
      try {
        const result = await a.auditRender({
          person: { bytes: readFileSync(path.join(PEOPLE_DIR, job.personFile)), mimeType: mime(job.personFile) },
          garment: { bytes: readFileSync(path.join(GARMENTS_DIR, job.garmentFile)), mimeType: mime(job.garmentFile) },
          output: { bytes: readFileSync(rec.outputPath), mimeType: mime(rec.outputPath) },
          garmentLabel: job.label,
          category: job.labelCategory,
        });
        mkdirSync(AUDITS_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify({ provider: a.name, at: new Date().toISOString(), seconds: (Date.now() - started) / 1000, output: rec.outputPath, audit: result }, null, 2));
        rec.audit = { status: "ok", provider: a.name, path: rel(file), result };
      } catch (err) {
        console.warn(`  [audit] unavailable, falling back to pixel checks: ${(err as Error).message}`);
        rec.audit = { status: "unavailable", provider: a.name, error: (err as Error).message };
      }
    }
  }

  rec.verdict = decideCardVerdict({
    garmentLabel: job.label,
    framing: job.framing,
    audit: rec.audit?.status === "ok" ? rec.audit.result : undefined,
    auditStatus: rec.audit?.status ?? "not_configured",
    pixel: {
      regionUnchanged: rec.badRender?.flagged ?? false,
      length: rec.lengthCheck,
    },
  });
}

const rel = (f: string) => path.relative(process.cwd(), f).replaceAll("\\", "/");
