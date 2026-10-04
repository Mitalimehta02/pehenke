import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkBadRender } from "./badRender";

const W = 600;
const H = 1000;

/** grey background, skin-ish head, and a coloured torso block */
async function person(torso: string, noise = 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="#ccc"/>
    <circle cx="300" cy="110" r="70" fill="#b28e73"/>
    <rect x="160" y="190" width="280" height="330" fill="${torso}"/>
    <rect x="190" y="520" width="220" height="400" fill="#334"/>
  </svg>`;
  let img = sharp(Buffer.from(svg)).jpeg({ quality: 90 });
  if (noise) img = sharp(await img.toBuffer()).modulate({ brightness: 1 + noise }).jpeg({ quality: 70 });
  return img.toBuffer();
}

describe("checkBadRender", () => {
  it("flags an output whose clothing region is unchanged (re-encoded only)", async () => {
    const input = await person("#b22222");
    const output = await person("#b22222", 0.02);
    const r = await checkBadRender(input, output, "full", "upper_body");
    expect(r.flagged).toBe(true);
    expect(r.changedPct).toBeLessThan(0.05);
  });

  it("passes an output where the top was replaced", async () => {
    const input = await person("#b22222");
    const output = await person("#1e90ff");
    const r = await checkBadRender(input, output, "full", "upper_body");
    expect(r.flagged).toBe(false);
    expect(r.changedPct).toBeGreaterThan(0.5);
  });

  it("reports aspect ratio changes", async () => {
    const input = await person("#b22222");
    const output = await sharp(await person("#1e90ff")).resize(600, 800, { fit: "fill" }).toBuffer();
    expect((await checkBadRender(input, output, "full", "upper_body")).aspectChanged).toBe(true);
  });
});
