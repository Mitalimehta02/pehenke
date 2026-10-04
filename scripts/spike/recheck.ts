// npm run spike:recheck  -> free: re-runs the pixel guards (bad render, garment
// length) on every cached try-on output and rewrites results.csv. No API calls.
import { readFileSync } from "node:fs";
import { defaultLength } from "./guards";
import { writeResultsCsv } from "./csv";
import { analyseOutput, describe, report } from "./runner";
import { loadCache, saveRecord } from "./store";

async function main() {
  for (const rec of Object.values(loadCache())) {
    if (rec.job.kind !== "tryon" || rec.status !== "success" || !rec.outputPath) continue;
    // records made before the length guard existed have no expected length yet
    rec.job.expectedLength ??= defaultLength(rec.job.label);
    Object.assign(rec, await analyseOutput(rec.job, readFileSync(rec.outputPath)));
    saveRecord(rec);
    console.log(describe(rec.job));
    report(rec);
  }
  console.log(`\nresults: ${writeResultsCsv(Object.values(loadCache()))}`);
}

main();
