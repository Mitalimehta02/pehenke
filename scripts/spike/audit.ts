// npm run spike:audit  -> render audit of cached try-on outputs that have none yet
// (no YouCam units), then the card verdict. Skips cleanly without a provider key.
// Filters: --garments a.jpg,b.jpg  --people model1  --redo (audit again even if cached)
import "./loadEnv";
import { parseArgs } from "node:util";
import { writeResultsCsv } from "./csv";
import { describe } from "./runner";
import { loadCache, saveRecord } from "./store";
import { auditAndDecide } from "./verdict";

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()) : undefined);

async function main() {
  const { values: args } = parseArgs({ options: { garments: { type: "string" }, people: { type: "string" }, redo: { type: "boolean", default: false } } });
  const recs = Object.values(loadCache()).filter(
    (r) =>
      r.job.kind === "tryon" &&
      r.status === "success" &&
      (!list(args.garments) || list(args.garments)!.includes(r.job.garmentFile)) &&
      (!list(args.people) || list(args.people)!.includes(r.job.person)),
  );
  for (const rec of recs) {
    console.log(describe(rec.job));
    await auditAndDecide(rec, { callProvider: true, redo: args.redo });
    saveRecord(rec);
    console.log(`  audit ${rec.audit?.status}; ${JSON.stringify(rec.verdict)}`);
  }
  writeResultsCsv(Object.values(loadCache()));
}

main();
