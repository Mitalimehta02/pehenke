import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkGarmentLength, defaultLength } from "./guards";

const W = 400;
const H = 1000;

/** grey backdrop; head at top, legs in pink leggings, a garment block from y=180 to `hem` */
async function person(garment: string | null, hem: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="#e8e8e8"/>
    <circle cx="200" cy="90" r="60" fill="#b28e73"/>
    <rect x="130" y="150" width="140" height="800" fill="#e0407a"/>
    <rect x="120" y="150" width="160" height="${hem - 150}" fill="${garment ?? "#f4f0e0"}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function garmentPhoto(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" fill="#ffffff"/><rect x="150" y="60" width="300" height="280" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("checkGarmentLength", () => {
  it("flags a crop garment rendered tunic-length", async () => {
    const input = await person(null, 620);
    const output = await person("#1e6bd6", 560); // hem at ~0.56 of the body
    const r = await checkGarmentLength({ input, output, garment: await garmentPhoto("#1e6bd6"), framing: "full", expectedLength: "crop" });
    expect(r?.flagged).toBe(true);
    expect(r!.hemPos).toBeGreaterThan(0.45);
  });

  it("passes a crop garment that ends at the waist, ignoring the leggings below", async () => {
    const input = await person(null, 620);
    const output = await person("#1e6bd6", 420);
    const r = await checkGarmentLength({ input, output, garment: await garmentPhoto("#1e6bd6"), framing: "full", expectedLength: "crop" });
    expect(r?.flagged).toBe(false);
  });

  it("reports an undetermined hem instead of flagging when the garment colours aren't found", async () => {
    const input = await person(null, 620);
    const output = await person("#1e6bd6", 560);
    const r = await checkGarmentLength({ input, output, garment: await garmentPhoto("#22aa22"), framing: "full", expectedLength: "crop" });
    expect(r?.determined).toBe(false);
    expect(r?.flagged).toBe(false);
  });

  it("is skipped for chest framing", async () => {
    const img = await person("#1e6bd6", 420);
    expect(await checkGarmentLength({ input: img, output: img, garment: img, framing: "chest", expectedLength: "crop" })).toBeUndefined();
  });

  it("derives expected length from common labels", () => {
    expect(defaultLength("choli")).toBe("crop");
    expect(defaultLength("men's kurta")).toBe("knee");
    expect(defaultLength("Lehenga")).toBe("floor");
    expect(defaultLength("dupatta set")).toBeUndefined();
  });
});
