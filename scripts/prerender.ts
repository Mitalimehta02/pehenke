// npm run prerender              -> dry run: which sample x garment renders are missing, and their cost
// npm run prerender -- --yes     -> render them (spends units), capped by --max-units (default 24)
//
// Pre-renders every try-on-ready demo garment on every sample photo, so the demo path is fully
// cached (buyers using a sample photo never trigger a new render). Never renders a cached hash.
import "dotenv/config";
import { parseArgs } from "node:util";
import { getApp } from "@/lib/server/app";
import { inputsHash } from "@/lib/tryon/hash";
import { CHANGE_SHOES } from "@/lib/tryon/service";
import { RENDER_UNITS } from "@/lib/units/ledger";
import { DEMO_SELLER } from "../prisma/seed";

async function main() {
  const { values: args } = parseArgs({ options: { yes: { type: "boolean", default: false }, "max-units": { type: "string", default: "24" } } });
  const maxUnits = Number(args["max-units"]);
  const app = await getApp();
  const { prisma } = app;

  const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: DEMO_SELLER.slug } });
  const garments = await prisma.garment.findMany({
    where: { sellerId: seller.id, active: true, OR: [{ gateStatus: "approved" }, { gateStatus: "needs_review", sellerConfirmed: true }] },
    orderBy: { createdAt: "asc" },
  });
  const samples = await prisma.buyerPhoto.findMany({ where: { isSample: true }, orderBy: { createdAt: "asc" } });

  const plan: Array<{ garment: (typeof garments)[number]; sample: (typeof samples)[number]; cached: boolean }> = [];
  for (const sample of samples) {
    for (const garment of garments) {
      const hash = inputsHash({ garmentPhotoHash: garment.photoHash, personPhotoHash: sample.hash, category: garment.category, changeShoes: CHANGE_SHOES });
      const t = await prisma.tryOn.findUnique({ where: { inputsHash: hash } });
      plan.push({ garment, sample, cached: t?.status === "succeeded" });
    }
  }
  const todo = plan.filter((p) => !p.cached);
  const cost = todo.length * RENDER_UNITS;
  console.log(`\nDemo garments ready for try-on: ${garments.length}; sample photos: ${samples.length}`);
  for (const p of plan) console.log(`  ${p.cached ? "cached" : "RENDER"}  ${p.garment.label} on ${p.sample.sampleName}`);
  console.log(`\nNew renders: ${todo.length} x ${RENDER_UNITS} units = ${cost} units (charged only on success). Cap for this run: ${maxUnits}.`);
  console.log(`Units already spent today: ${await app.ledger.youcamUnitsToday()} of the ${app.ledger.caps.youcamDailyUnits} daily cap.`);

  if (!args.yes) return console.log("\nDry run: nothing spent. Re-run with --yes to render.");
  if (cost > maxUnits) throw new Error(`This would cost ${cost} units, over --max-units ${maxUnits}. Not starting.`);

  for (const p of todo) {
    const r = await app.tryOns.request({ garmentId: p.garment.id, buyerPhotoId: p.sample.id, buyerId: null });
    if (r.kind === "refused") throw new Error(`refused (${r.reason}) at ${p.garment.label} on ${p.sample.sampleName}`);
    await app.tryOns.idle(); // one at a time
    const t = await prisma.tryOn.findUniqueOrThrow({ where: { id: r.tryOn.id } });
    console.log(`  ${t.status}${t.verdict ? ` / ${t.verdict}` : ""}  ${p.garment.label} on ${p.sample.sampleName}  ${t.latencyMs ? `${(t.latencyMs / 1000).toFixed(1)}s` : ""}  ${t.blockReason ?? t.error ?? ""}  output: ${t.outputKey ?? "-"}`);
  }
  await app.ledger.flush();
  console.log(`\nUnits spent today now: ${await app.ledger.youcamUnitsToday()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
