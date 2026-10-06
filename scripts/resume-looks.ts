// npm run looks:resume  -> finish looks interrupted mid-run (e.g. the database connection dropped).
// A step that already has a task id is polled, never started again, so a paid step is not paid twice.
// A look whose remaining steps were never started would start them: this prints what is open first,
// and only continues with --yes.
import "dotenv/config";
import { parseArgs } from "node:util";
import { getApp } from "@/lib/server/app";

async function main() {
  const { values: args } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  const app = await getApp();
  const { prisma } = app;
  const open = await prisma.look.findMany({ where: { status: { in: ["queued", "running"] } }, include: { tryOn: { include: { garment: true, buyerPhoto: true } } } });
  if (!open.length) return void console.log("No interrupted looks.");
  let unstarted = 0;
  for (const l of open) {
    const hashes = l.stepHashes as string[];
    const steps = await prisma.lookStep.findMany({ where: { hash: { in: hashes } } });
    const state = hashes.map((h) => {
      const s = steps.find((x) => x.hash === h);
      if (!s || (s.status !== "succeeded" && !s.taskId)) unstarted++;
      return s ? `${s.feature} ${s.status}${s.status === "running" && s.taskId ? " (task saved: will be polled)" : ""}` : "not started";
    });
    console.log(`${l.tryOn.buyerPhoto.sampleName ?? "buyer"} | ${l.tryOn.garment.label}: ${state.join(" -> ")}`);
  }
  console.log(`Steps that would be started new (1 unit each): ${unstarted}`);
  if (!args.yes) return void console.log("Dry run. Add --yes to resume.");
  await app.looks.resumeAll();
  await app.looks.idle();
  await app.ledger.flush();
  for (const l of await prisma.look.findMany({ where: { id: { in: open.map((o) => o.id) } } })) {
    console.log(`  -> ${l.status}${l.error ? `: ${l.error}` : ""}, ${l.units} unit(s) recorded on the look`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message.replace(/postgres(ql)?:\/\/\S+/g, "<url>").replace(/[a-z0-9.-]+\.neon\.tech/g, "<db-host>"));
    process.exit(1);
  });
