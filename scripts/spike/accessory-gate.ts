// npm run spike:gate  -> free: run the jewellery photo gate on the spike's jewellery photos.
// Calibration aid: prints the decision and the measurements behind it. No API calls.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAccessoryPhoto, cropPhoto } from "@/lib/gate/accessoryGate";

const J = path.join(process.cwd(), "spike-assets", "jewellery");
const INPUTS = path.join(process.cwd(), "spike-output", "look", "inputs");
const CASES: Array<[string, "earring" | "necklace", string]> = [
  [path.join(J, "necklace-ushape.jpg"), "necklace", "approved"],
  [path.join(J, "necklace-flatlay.jpg"), "necklace", "rejected"],
  [path.join(INPUTS, "earring-single.jpg"), "earring", "approved"],
  [path.join(J, "earrings-pair.jpg"), "earring", "needs_review (pair, crop offered)"],
  [path.join(J, "earrings-card.jpg"), "earring", "rejected or pair"],
  [path.join(J, "earrings-silver.jpg"), "earring", "needs_review (pair, crop offered)"],
];

async function main() {
  for (const [file, type, expected] of CASES) {
    if (!existsSync(file)) {
      console.log(`${path.basename(file)}: missing`);
      continue;
    }
    const r = await checkAccessoryPhoto({ bytes: readFileSync(file), type });
    console.log(`${path.basename(file).padEnd(24)} ${type.padEnd(9)} -> ${r.status} ${r.problems.join(",") || "-"}  (expected: ${expected})`);
    console.log(`    ${JSON.stringify(r.seen)}${r.cropSuggestion ? `  crop ${JSON.stringify(r.cropSuggestion)}` : ""}`);
    if (r.cropSuggestion) {
      const out = path.join(process.cwd(), "spike-output", "look", "gate");
      mkdirSync(out, { recursive: true });
      const cropped = await cropPhoto(readFileSync(file), r.cropSuggestion);
      writeFileSync(path.join(out, `crop-of-${path.basename(file)}`), cropped);
      const again = await checkAccessoryPhoto({ bytes: cropped, type });
      console.log(`    crop saved; gate on the crop itself -> ${again.status} ${again.problems.join(",") || "-"}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
