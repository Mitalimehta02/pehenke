// Free calls only: feature-cost table and balance check. Also records the
// balance baseline the spike budget is measured against.
import "./loadEnv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLOTHES_V3, SKIN_TONE, YouCamApiError, skusForFeature, unitsPerImage } from "@/lib/youcam";
import { budget, formatBudget, spikeClient } from "./runner";
import { OUT, loadCache, loadLedger, loadPending, saveLedger } from "./store";

async function main() {
  const client = spikeClient();

  const skus = await client.featureCosts();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "feature-costs.json"), JSON.stringify(skus, null, 2));
  console.log(`\nfeature-cost: ${skus.length} SKUs (full table in spike-output/feature-costs.json)\n`);

  for (const feature of [CLOTHES_V3, SKIN_TONE]) {
    const rows = skusForFeature(skus, feature);
    console.log(`${feature}:`);
    if (!rows.length) console.log("  (no SKU whose run_task_url is this feature's task endpoint)");
    for (const s of rows) console.log(`  ${s.amount} units per ${s.proc_unit} ${s.unit}  — ${s.description}`);
    console.log(`  => units per successful image: ${unitsPerImage(skus, feature) ?? "AMBIGUOUS/UNKNOWN"}\n`);
  }

  try {
    const bal = await client.balance();
    console.log(`balance: ${bal.total} units`);
    for (const e of bal.entries) console.log(`  ${e.type}: ${e.amount} (expires ${new Date(e.expiry).toISOString().slice(0, 10)})`);
    const ledger = loadLedger();
    const nothingSpent = Object.keys(loadCache()).length === 0 && loadPending().length === 0;
    if (ledger.baselineBalance === undefined && nothingSpent) {
      saveLedger({ baselineBalance: bal.total, baselineAt: new Date().toISOString() });
      console.log(`  recorded as the spike's budget baseline`);
    }
  } catch (err) {
    const why = err instanceof YouCamApiError ? `${err.httpStatus} ${err.errorCode ?? ""}`.trim() : (err as Error).message;
    console.log(`balance: unavailable with this key (${why}); units will be tracked from the cost table only`);
  }

  console.log(`\n${formatBudget(await budget(client))}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
