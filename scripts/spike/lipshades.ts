// npm run spike:lipshades  -> free: garment photo -> dominant colours -> two proposed lip shades.
// Prints them and writes a swatch sheet to spike-output/look/lip-shades.jpg. No API calls.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { lipShadesForGarment } from "@/lib/look/lipShade";

const GARMENTS = ["ghagra-museum-mannequin.jpg", "saree-museum-mannequin.jpg", "lehenga-worn.jpg", "lehenga-shop-mannequin.jpg", "kurti-green-worn.jpg"];
const OUT = path.join(process.cwd(), "spike-output", "look");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const rows: Buffer[] = [];
  for (const file of GARMENTS) {
    const bytes = readFileSync(path.join(process.cwd(), "spike-assets", "garments", file));
    const { colours, shades } = await lipShadesForGarment(bytes);
    console.log(`\n${file}`);
    console.log(`  garment colours: ${colours.map((c) => `${c.hex} ${Math.round(c.share * 100)}%${c.neutral ? " (neutral)" : ""}`).join(", ")}`);
    for (const [i, s] of shades.entries()) console.log(`  lip shade ${i + 1}: ${s.hex} ${s.name} (${s.why})`);

    const thumb = await sharp(bytes).rotate().resize(150, 200, { fit: "contain", background: "#ffffff" }).png().toBuffer();
    const sw = (x: number, hex: string, label: string, sub: string) =>
      `<rect x="${x}" y="40" width="110" height="110" rx="12" fill="${hex}"/><text x="${x}" y="172" font-size="15" font-family="sans-serif" fill="#222">${esc(label)}</text><text x="${x}" y="191" font-size="13" font-family="sans-serif" fill="#666">${esc(sub)}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="210"><rect width="100%" height="100%" fill="#fff"/>
      <text x="170" y="24" font-size="16" font-family="sans-serif" font-weight="bold" fill="#222">${esc(file)}</text>
      ${colours.map((c, i) => sw(170 + i * 125, c.hex, `garment ${Math.round(c.share * 100)}%`, c.hex + (c.neutral ? " neutral" : ""))).join("")}
      <text x="560" y="24" font-size="16" font-family="sans-serif" font-weight="bold" fill="#222">proposed lip shades</text>
      ${shades.map((s, i) => sw(560 + i * 200, s.hex, `${i + 1}. ${s.name}`, s.hex)).join("")}
    </svg>`;
    rows.push(await sharp(Buffer.from(svg)).composite([{ input: thumb, left: 8, top: 5 }]).png().toBuffer());
  }
  const sheet = path.join(OUT, "lip-shades.jpg");
  await sharp({ create: { width: 1000, height: 210 * rows.length, channels: 3, background: "#ffffff" } })
    .composite(rows.map((r, i) => ({ input: r, left: 0, top: i * 210 })))
    .jpeg({ quality: 88 })
    .toFile(sheet);
  console.log(`\nswatch sheet: ${sheet}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
