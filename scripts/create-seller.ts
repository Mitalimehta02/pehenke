// npm run seller:create -- --name "Rani Fashion" [--slug rani-fashion]
// npm run seller:create -- --new-link <slug>     -> new private seller link (the old one stops working)
//
// Creates a real seller and prints their private seller link (shown once; only its hash is
// stored) and the public chat link for buyers. Same code as /admin. Links use APP_URL.
// Needs the database (port 5432: hotspot/WARP from the home network). Spends no units.
import "dotenv/config";
import { parseArgs } from "node:util";
import { dbAsync } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { createSeller, OnboardError, rotateSellerKey, type CreatedSeller } from "@/lib/sellers/onboard";

async function main() {
  const { values: args } = parseArgs({ options: { name: { type: "string" }, slug: { type: "string" }, "new-link": { type: "string" } } });
  const prisma = await dbAsync();
  const base = appUrl();
  let s: CreatedSeller;
  if (args["new-link"]) {
    const seller = await prisma.seller.findUnique({ where: { slug: args["new-link"] } });
    if (!seller) throw new OnboardError(`No seller with link name "${args["new-link"]}".`);
    s = await rotateSellerKey(prisma, base, seller.id);
    console.log(`\nNew seller link for ${s.name}. The old link no longer works.`);
  } else {
    if (!args.name) throw new OnboardError('Usage: npm run seller:create -- --name "Shop name" [--slug link-name]');
    s = await createSeller(prisma, base, { name: args.name, slug: args.slug });
    console.log(`\nCreated ${s.name} (/${s.slug}).`);
  }
  console.log(`\nSeller link (PRIVATE, shown once; send only to the seller):\n  ${s.sellerUrl}`);
  console.log(`\nShop chat link (share with buyers):\n  ${s.chatUrl}\n`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof OnboardError ? err.message : err);
  process.exit(1);
});
