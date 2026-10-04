// npm run spike:recheck  -> free: re-runs the pixel guards and the card verdict on
// every cached try-on output (using cached audits; no Gemini or YouCam calls).
import "./loadEnv";
import { readFileSync } from "node:fs";
import { writeResultsCsv } from "./csv";
import { defaultLength } from "@/lib/guards/length";
import { analyseOutput, describe, report } from "./runner";
import { loadCache, saveRecord } from "./store";
import { auditAndDecide } from "./verdict";

async function main() {
  for (const rec of Object.values(loadCache())) {
    if (rec.job.kind !== "tryon" || rec.status !== "success" || !rec.outputPath) continue;
    // records made before the length guard existed have no expected length yet
    rec.job.expectedLength ??= defaultLength(rec.job.label);
    Object.assign(rec, await analyseOutput(rec.job, readFileSync(rec.outputPath)));
    await auditAndDecide(rec, { callProvider: false });
    saveRecord(rec);
    console.log(describe(rec.job));
    report(rec);
    if (rec.verdict) console.log(`  ${JSON.stringify(rec.verdict)}`);
  }
  console.log(`\nresults: ${writeResultsCsv(Object.values(loadCache()))}`);
}

main();
