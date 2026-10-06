// npm run looks:drop -- --sample "Sample model B" --garment "Green printed kurti"          -> dry run
// npm run looks:drop -- --sample "..." --garment "..." --yes                                 -> delete
//
// Remove a pre-rendered demo look that came out wrong (e.g. one earring only): the look, its
// images, and the cached steps behind it, so it is no longer served from the cache. The
// try-on itself and its close-up stay. Spends nothing.
import "dotenv/config";
import { parseArgs } from "node:util";
import { getApp } from "@/lib/server/app";

async function main() {
  const { values: args } = parseArgs({ options: { sample: { type: "string" }, garment: { type: "string" }, yes: { type: "boolean", default: false } } });
  if (!args.sample || !args.garment) throw new Error('usage: --sample "Sample model B" --garment "Green printed kurti" [--yes]');
  const { prisma, blobs } = await getApp();
  const looks = await prisma.look.findMany({
    where: { tryOn: { buyerPhoto: { isSample: true, sampleName: args.sample }, garment: { label: args.garment } } },
    include: { orders: { select: { id: true } } },
  });
  if (!looks.length) return void console.log("No look found for that sample and garment.");
  for (const l of looks) {
    const hashes = l.stepHashes as string[];
    const steps = await prisma.lookStep.findMany({ where: { hash: { in: hashes } } });
    console.log(`look ${l.status}, ${l.units} unit(s), steps: ${steps.map((s) => `${s.feature} ${s.status}`).join(", ")}; on ${l.orders.length} order(s)`);
    if (l.orders.length) {
      console.log("  kept: an order uses this look");
      continue;
    }
    if (!args.yes) continue;
    // a step may be shared with another look of the same render (e.g. the same earring, another lip shade)
    const others = await prisma.look.findMany({ where: { tryOnId: l.tryOnId, id: { not: l.id } }, select: { stepHashes: true } });
    const shared = new Set(others.flatMap((o) => o.stepHashes as string[]));
    const mine = steps.filter((s) => !shared.has(s.hash));
    await prisma.look.delete({ where: { id: l.id } });
    await prisma.lookStep.deleteMany({ where: { hash: { in: mine.map((s) => s.hash) } } });
    const keys = [l.outputKey, l.closeupKey, ...mine.map((s) => s.outputKey)].filter((k): k is string => !!k);
    console.log(`  deleted the look, ${mine.length} cached step(s) and ${await blobs.delete(keys)} image(s)`);
  }
  if (!args.yes) console.log("Dry run. Add --yes to delete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message.replace(/postgres(ql)?:\/\/\S+/g, "<url>").replace(/[a-z0-9.-]+\.neon\.tech/g, "<db-host>"));
    process.exit(1);
  });
