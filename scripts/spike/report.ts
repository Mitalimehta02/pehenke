// npm run spike:report  -> free: summary tables (markdown) from cached results, for SPIKE.md.
import "./loadEnv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadCache, type ResultRecord, type TryOnJob } from "./store";

type Rec = ResultRecord & { job: TryOnJob };

const recs = Object.values(loadCache()).filter((r): r is Rec => r.job.kind === "tryon");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

function table(title: string, keyOf: (r: Rec) => string, rows: Rec[] = recs) {
  const groups = new Map<string, Rec[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  console.log(`\n### ${title}\n`);
  console.log("| | renders | API success | send | disclose | block | median latency (s) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [k, rs] of [...groups].sort()) {
    const ok = rs.filter((r) => r.status === "success");
    const v = (x: string) => ok.filter((r) => r.verdict?.card_verdict === x).length;
    console.log(
      `| ${k} | ${rs.length} | ${ok.length}/${rs.length} | ${v("send")} | ${v("send_with_disclosure")} | ${v("block")} | ${median(ok.map((r) => r.latencySec ?? NaN).filter(Number.isFinite)).toFixed(1)} |`,
    );
  }
}

// Repeats are the same render again: count each (garment, person, category) once in the breakdowns.
const unique = recs.filter((r) => !r.job.repeat);

console.log(`## Totals\n`);
const ok = recs.filter((r) => r.status === "success");
console.log(`- renders: ${recs.length} (${unique.length} unique, ${recs.length - unique.length} repeats)`);
console.log(`- API success: ${ok.length}/${recs.length}`);
console.log(`- errors: ${recs.filter((r) => r.status !== "success").map((r) => `${r.job.garmentFile} on ${r.job.personFile}: ${r.error} ${r.errorMessage ?? ""}`).join("; ") || "none"}`);
console.log(`- units recorded: ${recs.reduce((n, r) => n + r.units, 0)}; balance deltas: ${ok.map((r) => r.unitsBalanceDelta).join(",")}`);
console.log(`- latency (s): median ${median(ok.map((r) => r.latencySec!)).toFixed(1)}, min ${Math.min(...ok.map((r) => r.latencySec!))}, max ${Math.max(...ok.map((r) => r.latencySec!))}`);
const vc = (x: string) => unique.filter((r) => r.verdict?.card_verdict === x).length;
console.log(`- verdicts (unique renders): send ${vc("send")}, send_with_disclosure ${vc("send_with_disclosure")}, block ${vc("block")}, none ${unique.filter((r) => !r.verdict).length}`);
const as = (x: string) => recs.filter((r) => r.audit?.status === x).length;
console.log(`- audit status: ok ${as("ok")}, unavailable ${as("unavailable")}, not_configured ${as("not_configured")}`);

table("By garment type (label)", (r) => r.job.label, unique.filter((r) => r.job.category !== "auto"));
table("By photo type", (r) => r.job.photoType, unique.filter((r) => r.job.category !== "auto"));
table("By person / framing", (r) => `${r.job.person}-${r.job.framing}`, unique.filter((r) => r.job.category !== "auto"));
table("By category sent", (r) => r.job.category, unique);

console.log(`\n### Every unique render\n`);
console.log("| garment | photo | person | category | status | latency | verdict | reason / disclosure | audit added | reference leak | hem (expected) |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of unique.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
  const a = r.audit?.result;
  console.log(
    `| ${r.job.garmentFile} | ${r.job.photoType} | ${r.job.personFile} | ${r.job.category} | ${r.status}${r.error ? ` (${r.error})` : ""} | ${r.latencySec ?? ""} | ${r.verdict?.card_verdict ?? ""} | ${(r.verdict?.block_reason ?? r.verdict?.disclosure_text ?? "").replaceAll("|", "/")} | ${a?.added_items.map((i) => i.item).join(", ") ?? r.audit?.status ?? ""} | ${a?.reference_leak?.leaked.map((l) => `${l.what}: ${l.item}`).join(", ") ?? ""} | ${r.lengthCheck ? `${r.lengthCheck.determined === false ? "unknown" : r.lengthCheck.hemPos.toFixed(2)} (${r.lengthCheck.expected})` : "n/a"} |`,
  );
}

console.log(`\n### auto vs labelled category (same garment, same person)\n`);
const fileHash = (p?: string) => (p && existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12) : "-");
for (const a of unique.filter((r) => r.job.category === "auto")) {
  const l = unique.find((r) => r.job.category !== "auto" && r.job.garmentFile === a.job.garmentFile && r.job.personFile === a.job.personFile);
  const same = l && fileHash(a.outputPath) === fileHash(l.outputPath);
  console.log(`- ${a.job.garmentFile} (labelled ${a.job.labelCategory}): auto ${a.status}, labelled ${l?.status ?? "not run"}; outputs ${same ? "byte-identical" : "differ"} (auto ${fileHash(a.outputPath)}, labelled ${fileHash(l?.outputPath)}); auto verdict ${a.verdict?.card_verdict}, labelled verdict ${l?.verdict?.card_verdict}`);
}
