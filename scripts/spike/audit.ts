// npm run spike:audit  -> render audit of cached try-on outputs (no YouCam units).
// One audit per output, cached in spike-output/audits/. Skips cleanly without a provider key.
// Filters: --garments a.jpg,b.jpg  --people model1  --redo (audit again even if cached)
import "./loadEnv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { auditorFromEnv, type RenderAudit } from "@/lib/audit";
import { writeResultsCsv } from "./csv";
import { describe } from "./runner";
import { GARMENTS_DIR, OUT, PEOPLE_DIR, loadCache, saveRecord } from "./store";

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()) : undefined);
const mime = (f: string) => (/\.png$/i.test(f) ? "image/png" : "image/jpeg") as "image/png" | "image/jpeg";

async function main() {
  const { values: args } = parseArgs({ options: { garments: { type: "string" }, people: { type: "string" }, redo: { type: "boolean", default: false } } });
  const auditor = auditorFromEnv();
  if (!auditor) {
    console.log("No GEMINI_API_KEY set: render audit skipped.");
    return;
  }
  const dir = path.join(OUT, "audits");
  mkdirSync(dir, { recursive: true });

  const recs = Object.values(loadCache()).filter(
    (r) =>
      r.job.kind === "tryon" &&
      r.status === "success" &&
      r.outputPath &&
      (!list(args.garments) || list(args.garments)!.includes(r.job.garmentFile)) &&
      (!list(args.people) || list(args.people)!.includes(r.job.person)),
  );
  console.log(`Auditing with ${auditor.name}, one at a time (${recs.length} outputs)\n`);

  for (const rec of recs) {
    if (rec.job.kind !== "tryon") continue;
    const job = rec.job;
    const file = path.join(dir, `${path.basename(rec.outputPath!, path.extname(rec.outputPath!))}.json`);
    if (existsSync(file) && !args.redo) {
      console.log(`cached  ${describe(job)}`);
      continue;
    }
    console.log(`audit   ${describe(job)}`);
    const started = Date.now();
    try {
      const audit: RenderAudit = await auditor.auditRender({
        person: { bytes: readFileSync(path.join(PEOPLE_DIR, job.personFile)), mimeType: mime(job.personFile) },
        garment: { bytes: readFileSync(path.join(GARMENTS_DIR, job.garmentFile)), mimeType: mime(job.garmentFile) },
        output: { bytes: readFileSync(rec.outputPath!), mimeType: mime(rec.outputPath!) },
        garmentLabel: job.label,
        category: job.labelCategory,
      });
      const entry = { provider: auditor.name, at: new Date().toISOString(), seconds: (Date.now() - started) / 1000, output: rec.outputPath, audit };
      writeFileSync(file, JSON.stringify(entry, null, 2));
      rec.audit = { provider: auditor.name, path: path.relative(process.cwd(), file).replaceAll("\\", "/"), result: audit };
      saveRecord(rec);
      console.log(JSON.stringify(audit, null, 2));
    } catch (err) {
      console.log(`  audit failed: ${(err as Error).message}`);
    }
  }
  writeResultsCsv(Object.values(loadCache()));
}

main();
