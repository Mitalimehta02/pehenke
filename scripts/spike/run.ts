// npm run spike                  -> dry run: plan + cost estimate, spends nothing
// npm run spike -- --yes         -> spend units (only after human approval)
//
// Filters: --garments a.jpg,b.jpg  --people priya  --framing full,chest
//          --category auto (send "auto" instead of the labelled category)
//          --retry-errors (re-run cached task errors; they cost nothing)
import "./loadEnv";
import { parseArgs } from "node:util";
import { CLOTHES_V3, TaskPollTimeoutError, type GarmentCategory } from "@/lib/youcam";
import { loadGarments, loadPeople, planTryOns } from "./assets";
import { writeResultsCsv } from "./csv";
import { BudgetStop, budget, describe, executeJob, formatBudget, report, resumePending, spikeClient } from "./runner";
import { loadCache, type Framing } from "./store";

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

async function main() {
  const { values: args } = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      garments: { type: "string" },
      people: { type: "string" },
      framing: { type: "string" },
      category: { type: "string" },
      "retry-errors": { type: "boolean", default: false },
    },
  });

  const client = spikeClient();
  await client.featureCosts();
  const cost = client.unitCost(CLOTHES_V3);

  // Plan change C: finish paid tasks from earlier runs before anything new.
  const stillRunning = await resumePending(client);
  if (stillRunning.length) {
    console.log(`\n${stillRunning.length} earlier task(s) still running. Not starting anything new; re-run to keep polling.`);
    writeResultsCsv(Object.values(loadCache()));
    process.exit(2);
  }

  const plan = planTryOns(loadGarments(), loadPeople(), {
    garments: list(args.garments),
    people: list(args.people),
    framings: list(args.framing) as Framing[] | undefined,
    categoryOverride: args.category as GarmentCategory | undefined,
  });

  const cache = loadCache();
  const isDone = (key: string) => {
    const r = cache[key];
    return r && !(args["retry-errors"] && r.status === "error");
  };
  const todo = plan.jobs.filter((j) => !isDone(j.key));

  console.log(`\nPlan: ${plan.jobs.length} try-on(s), ${plan.jobs.length - todo.length} cached, ${todo.length} to run`);
  for (const j of plan.jobs) console.log(`  ${isDone(j.key) ? "cached " : "RUN    "} ${describe(j)}`);
  for (const s of plan.skipped) console.log(`  skipped ${s.what}: ${s.reason}`);

  const b = await budget(client);
  const estimate = cost === null ? null : todo.length * cost;
  console.log(`\ncloth-v3 cost: ${cost ?? "UNKNOWN"} units per successful try-on (charged only on success)`);
  console.log(`Estimated cost of this run: ${estimate ?? "UNKNOWN"} units (worst case: every task succeeds)`);
  console.log(`Budget now: ${formatBudget(b)}`);
  if (estimate !== null) console.log(`After this run (worst case): ${b.spent + b.reserved + estimate} / ${b.cap}`);

  if (!args.yes || todo.length === 0) {
    writeResultsCsv(Object.values(loadCache()));
    console.log(todo.length ? `\nDry run: nothing spent. Re-run with --yes and the same filters to spend.` : `\nNothing to run.`);
    return;
  }
  if (estimate === null) throw new BudgetStop("cloth-v3 cost is unknown from feature-cost; refusing to spend.");
  if (b.spent + b.reserved + estimate > b.cap) {
    throw new BudgetStop(`This run could take the spike to ${b.spent + b.reserved + estimate} units, over the ${b.cap} cap. Not starting.`);
  }

  for (const [i, job] of todo.entries()) {
    console.log(`\n[${i + 1}/${todo.length}] ${describe(job)}`);
    try {
      report(await executeJob(client, job));
    } catch (err) {
      if (err instanceof TaskPollTimeoutError) {
        console.log(`  still running after ${Math.round(err.waitedMs / 1000)}s; kept in pending.json. Stopping; re-run to resume.`);
        break;
      }
      throw err;
    } finally {
      console.log(`  [budget] ${formatBudget(await budget(client))}`);
    }
  }

  const file = writeResultsCsv(Object.values(loadCache()));
  console.log(`\nresults: ${file}`);
}

main().catch((err) => {
  writeResultsCsv(Object.values(loadCache()));
  console.error(`\n${err instanceof BudgetStop ? "STOPPED: " : ""}${(err as Error).message}`);
  process.exit(err instanceof BudgetStop ? 3 : 1);
});
