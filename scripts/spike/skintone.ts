// npm run spike:skintone -- --person <file>        -> dry run with cost
// npm run spike:skintone -- --person <file> --yes  -> one paid call
import "./loadEnv";
import { parseArgs } from "node:util";
import { SKIN_TONE, TaskPollTimeoutError } from "@/lib/youcam";
import { planSkinTone } from "./assets";
import { BudgetStop, budget, describe, executeJob, formatBudget, report, resumePending, spikeClient } from "./runner";
import { loadCache } from "./store";

async function main() {
  const { values: args } = parseArgs({ options: { person: { type: "string" }, yes: { type: "boolean", default: false } } });
  if (!args.person) throw new Error("--person <file in spike-assets/people> is required");

  const client = spikeClient();
  await client.featureCosts();
  if ((await resumePending(client)).length) {
    console.log("Earlier tasks still running; not starting anything new.");
    process.exit(2);
  }

  const job = planSkinTone(args.person);
  const cached = loadCache()[job.key];
  const cost = client.unitCost(SKIN_TONE);
  console.log(`\n${describe(job)}: ${cached ? `cached (${cached.status})` : "not run yet"}`);
  console.log(`skin-tone-analysis cost: ${cost ?? "UNKNOWN"} units (charged only on success)`);
  console.log(`Budget now: ${formatBudget(await budget(client))}`);
  if (cached) {
    console.log(JSON.stringify(cached.skinTone ?? cached.error, null, 2));
    return;
  }
  if (!args.yes) {
    console.log("\nDry run: nothing spent. Add --yes to spend.");
    return;
  }
  try {
    const rec = await executeJob(client, job);
    report(rec);
    if (rec.skinTone) console.log(JSON.stringify(rec.skinTone, null, 2));
  } catch (err) {
    if (err instanceof TaskPollTimeoutError) console.log("Still running; kept in pending.json. Re-run to resume.");
    else throw err;
  } finally {
    console.log(`[budget] ${formatBudget(await budget(client))}`);
  }
}

main().catch((err) => {
  console.error(`${err instanceof BudgetStop ? "STOPPED: " : ""}${(err as Error).message}`);
  process.exit(err instanceof BudgetStop ? 3 : 1);
});
