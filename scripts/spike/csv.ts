import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OUT, type ResultRecord } from "./store";

const COLUMNS = [
  "garment",
  "label",
  "label_category",
  "category_sent",
  "photo_type",
  "person",
  "person_file",
  "framing",
  "repeat",
  "status",
  "latency_s",
  "units_consumed",
  "units_balance_delta",
  "error",
  "error_message",
  "bad_render_flag",
  "clothing_region_changed_pct",
  "aspect_changed",
  "expected_length",
  "hem_pos",
  "length_flag",
  "card_verdict",
  "disclosure_text",
  "block_reason",
  "next_step",
  "audit_status",
  "audit_added_items",
  "audit_length_matches",
  "audit_drape",
  "audit_reference_leak",
  "output_path",
  "output_w",
  "output_h",
  "task_id",
  "resumed",
  "started_at",
  "finished_at",
] as const;

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rewrites results.csv from every cached try-on record. */
export function writeResultsCsv(records: ResultRecord[]): string {
  const rows = records
    .filter((r) => r.job.kind === "tryon")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((r) => {
      const j = r.job.kind === "tryon" ? r.job : undefined!;
      const row: Record<(typeof COLUMNS)[number], unknown> = {
        garment: j.garmentFile,
        label: j.label,
        label_category: j.labelCategory,
        category_sent: j.category,
        photo_type: j.photoType,
        person: j.person,
        person_file: j.personFile,
        framing: j.framing,
        repeat: j.repeat ?? 0,
        status: r.status,
        latency_s: r.latencySec,
        units_consumed: r.units,
        units_balance_delta: r.unitsBalanceDelta,
        error: r.error,
        error_message: r.errorMessage,
        bad_render_flag: r.badRender ? (r.badRender.flagged ? "yes" : "no") : "",
        clothing_region_changed_pct: r.badRender ? (r.badRender.changedPct * 100).toFixed(1) : "",
        aspect_changed: r.badRender ? (r.badRender.aspectChanged ? "yes" : "no") : "",
        expected_length: r.lengthCheck?.expected ?? j.expectedLength,
        hem_pos: r.lengthCheck ? (r.lengthCheck.determined === false ? "unknown" : r.lengthCheck.hemPos.toFixed(2)) : "",
        length_flag: r.lengthCheck ? (r.lengthCheck.flagged ? "yes" : "no") : "",
        card_verdict: r.verdict?.card_verdict,
        disclosure_text: r.verdict?.disclosure_text,
        block_reason: r.verdict?.block_reason,
        next_step: r.verdict?.next_step,
        audit_status: r.audit?.status ?? (r.status === "success" ? "not_run" : ""),
        audit_added_items: r.audit?.result?.added_items.map((i) => `${i.kind}: ${i.item}`).join("; "),
        audit_length_matches: r.audit?.result ? (r.audit.result.length.matches ? "yes" : "no") : "",
        audit_drape: r.audit?.result?.drape,
        audit_reference_leak: r.audit?.result?.reference_leak?.leaked.map((l) => `${l.what}: ${l.item}`).join("; "),
        output_path: r.outputPath,
        output_w: r.outputWidth,
        output_h: r.outputHeight,
        task_id: r.taskId,
        resumed: r.resumed ? "yes" : "",
        started_at: r.startedAt,
        finished_at: r.finishedAt,
      };
      return COLUMNS.map((c) => cell(row[c])).join(",");
    });
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "results.csv");
  writeFileSync(file, [COLUMNS.join(","), ...rows].join("\n") + "\n");
  return file;
}
