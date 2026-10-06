// npm run prerender:looks              -> dry run: one look per cached sample render, and its cost
// npm run prerender:looks -- --yes     -> render them (spends units), capped by --max-units (default 20)
//
// Pre-renders one "hero" look for every cached demo render (sample model x demo garment), so
// the demo's "Complete the look" is instant and free for visitors who pick the same items:
// the first earring (only where the ear check passes), the necklace (only where a person has
// confirmed the neck is bare in that render: NECK_BARE below), and the first proposed lip
// shade. Steps are cached, so nothing is ever rendered twice. Needs the database.
//
// npm run prerender:looks -- --lip-only   -> only the renders whose look failed earlier and that
//                                            have no finished look: a lip-shade-only look for each.
import "dotenv/config";
import { parseArgs } from "node:util";
import { getApp } from "@/lib/server/app";
import { lipShadesForGarment } from "@/lib/look/lipShade";
import { accessoryTryable, type LookPrep } from "@/lib/look/service";
import { DEMO_SELLER } from "../prisma/seed";

/**
 * "Is the neck bare in this render?", answered by a person looking at each demo render
 * (there is no reliable automatic check: SPIKE.md). Key: "<sample name> | <garment label>".
 * Anything not listed counts as not bare, so no necklace is drawn on it.
 */
const NECK_BARE: Record<string, boolean> = {
  "Sample model A | Mustard and maroon ghagra set": false, // high collar
  "Sample model A | Ivory zari silk saree": false, // the try-on already drew a chain
  "Sample model A | Sage and pink lehenga with dupatta": true,
  "Sample model A | Green printed kurti": false, // collar
  "Sample model B | Mustard and maroon ghagra set": false, // high collar
  "Sample model B | Ivory zari silk saree": true,
  "Sample model B | Sage and pink lehenga with dupatta": true,
  "Sample model B | Green printed kurti": false, // collar
};

async function main() {
  const { values: args } = parseArgs({ options: { yes: { type: "boolean", default: false }, "lip-only": { type: "boolean", default: false }, "max-units": { type: "string", default: "20" } } });
  const lipOnly = args["lip-only"];
  const maxUnits = Number(args["max-units"]);
  const app = await getApp();
  const { prisma, blobs } = app;
  const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: DEMO_SELLER.slug } });
  const accessories = (await prisma.accessory.findMany({ where: { sellerId: seller.id }, orderBy: { createdAt: "asc" } })).filter(accessoryTryable);
  const earring = accessories.find((a) => a.type === "earring");
  const necklace = accessories.find((a) => a.type === "necklace");
  const renders = await prisma.tryOn.findMany({
    where: { status: "succeeded", verdict: { not: "block" }, buyerPhoto: { isSample: true }, garment: { sellerId: seller.id, active: true } },
    include: { garment: true, buyerPhoto: true },
    orderBy: [{ buyerPhoto: { createdAt: "asc" } }, { garment: { createdAt: "asc" } }],
  });
  console.log(`\nDemo jewellery: earring "${earring?.label ?? "none"}", necklace "${necklace?.label ?? "none"}". Cached sample renders: ${renders.length}.\n`);

  const plan: Array<{ name: string; tryOnId: string; choice: { earringId: string | null; necklaceId: string | null; lip: { hex: string; name: string } | null }; units: number; note: string }> = [];
  for (const t of renders) {
    const name = `${t.buyerPhoto.sampleName} | ${t.garment.label}`;
    if (lipOnly) {
      const looks = await prisma.look.findMany({ where: { tryOnId: t.id }, select: { status: true } });
      if (looks.some((l) => l.status === "succeeded") || !looks.some((l) => l.status === "failed")) continue;
    }
    const { prep } = await app.looks.prepare(t.id); // free: face, crop, ear check, close-up
    if (!(prep as LookPrep).crop) {
      console.log(`  skip   ${name}: no usable face (${prep.problem})`);
      continue;
    }
    const garmentPhoto = await blobs.get(t.garment.photoKey);
    const lip = garmentPhoto ? (await lipShadesForGarment(garmentPhoto.bytes)).shades[0] : null;
    const choice = {
      earringId: !lipOnly && earring && prep.earsClear ? earring.id : null,
      necklaceId: !lipOnly && necklace && NECK_BARE[name] === true ? necklace.id : null,
      lip: lip ? { hex: lip.hex, name: lip.name } : null,
    };
    const units = await app.looks.estimate({ tryOnId: t.id, ...choice });
    const note = (
      lipOnly
        ? [lip ? `lip ${lip.name} ${lip.hex} only` : ""]
        : [
            choice.earringId ? "earring" : earring ? `no earring (ears ${prep.earPct}% / forehead ${prep.foreheadPct}% changed by the try-on)` : "",
            choice.necklaceId ? "necklace" : NECK_BARE[name] === undefined ? "no necklace (neck not reviewed)" : "no necklace (neck not bare)",
            lip ? `lip ${lip.name} ${lip.hex}` : "",
          ]
    )
      .filter(Boolean)
      .join(", ");
    plan.push({ name, tryOnId: t.id, choice, units, note });
    console.log(`  ${units ? `${units} unit${units === 1 ? " " : "s"}` : "cached "} ${name}: ${note}`);
  }
  const total = plan.reduce((n, p) => n + p.units, 0);
  console.log(`\nNew look steps: ${total} x 1 unit = ${total} units (charged only on success; failed steps are free). Cap for this run: ${maxUnits}.`);
  console.log(`Units already spent today: ${await app.ledger.youcamUnitsToday()} of the ${app.ledger.caps.youcamDailyUnits} daily cap.`);
  if (!args.yes) return void console.log("Dry run: nothing spent. Add --yes to render (only after approval).");
  if (total > maxUnits) throw new Error(`plan needs ${total} units, above --max-units ${maxUnits}`);

  for (const p of plan.filter((x) => x.units > 0)) {
    const r = await app.looks.request({ tryOnId: p.tryOnId, buyerId: null, ...p.choice });
    console.log(`  ${p.name}: ${r.kind}${r.kind === "refused" ? ` (${r.reason})` : ""}`);
    await app.looks.idle(); // one at a time
    if (r.kind !== "refused") {
      const look = await prisma.look.findUniqueOrThrow({ where: { id: r.look.id } });
      console.log(`      -> ${look.status}${look.error ? `: ${look.error}` : ""}, ${look.units} unit(s)${look.unitsWasted ? `, ${look.unitsWasted} wasted` : ""}${look.skipped ? `, left out: ${JSON.stringify(look.skipped)}` : ""}`);
    }
  }
  await app.ledger.flush();
  console.log(`\nUnits spent today: ${await app.ledger.youcamUnitsToday()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
