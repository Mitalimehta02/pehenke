import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dominantColours, hslToHex, lipShadesForGarment, proposeLipShades, rgbToHsl, type DominantColour } from "./lipShade";

/** A garment-like image: plain backdrop with a coloured block (and an optional border band). */
async function garment(main: string, backdrop = "#f4f4f4", band?: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">
    <rect width="100%" height="100%" fill="${backdrop}"/>
    <rect x="90" y="50" width="220" height="400" fill="${main}"/>
    ${band ? `<rect x="90" y="380" width="220" height="70" fill="${band}"/>` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const colour = (hexValue: string, share: number, neutral = false): DominantColour => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hexValue.slice(i, i + 2), 16));
  return { hex: hexValue, share, ...rgbToHsl(r, g, b), neutral };
};
const hue = (h: string) => rgbToHsl(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)).h;
/** every proposed shade must be a wearable lip colour: red / pink / coral family, not too pale or dark */
const wearable = (h: string) => {
  const c = rgbToHsl(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
  return (c.h >= 320 || c.h <= 25) && c.l >= 0.28 && c.l <= 0.64 && c.s >= 0.3;
};

describe("colour helpers", () => {
  it("round-trips hsl and hex", () => {
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(hslToHex(120, 1, 0.25)).toBe("#008000");
    const c = rgbToHsl(0x33, 0x66, 0x99);
    expect(hslToHex(c.h, c.s, c.l)).toBe("#336699");
  });
});

describe("dominantColours", () => {
  it("finds the garment colour and ignores the backdrop, light or dark", async () => {
    const onLight = await dominantColours(await garment("#1f9d3a"));
    expect(onLight[0].neutral).toBe(false);
    expect(Math.round(onLight[0].h / 10)).toBe(Math.round(hue("#1f9d3a") / 10));
    expect(onLight[0].share).toBeGreaterThan(0.9);
    const onDark = await dominantColours(await garment("#1f9d3a", "#101010"));
    expect(Math.round(onDark[0].h / 10)).toBe(Math.round(hue("#1f9d3a") / 10));
  });

  it("lists a second colour (border band) after the main one", async () => {
    const c = await dominantColours(await garment("#1f9d3a", "#f4f4f4", "#c2185b"));
    expect(c).toHaveLength(2);
    expect(c[0].share).toBeGreaterThan(c[1].share);
    expect(c[1].h).toBeGreaterThan(320);
  });

  it("reports an ivory garment as neutral", async () => {
    const c = await dominantColours(await garment("#ece3cf", "#7a7a7a"));
    expect(c[0].neutral).toBe(true);
  });
});

describe("proposeLipShades", () => {
  it.each([
    ["green", "#1f9d3a", "Rose pink"],
    ["red", "#c62828", "Tonal red"],
    ["mustard", "#d99a1c", "Warm coral red"],
    ["blue", "#1e5aa8", "Coral"],
    ["purple", "#6a2c91", "Plum berry"],
  ])("%s garment -> %s first", (_n, hexValue, name) => {
    const shades = proposeLipShades([colour(hexValue, 0.8)]);
    expect(shades).toHaveLength(2);
    expect(shades[0].name).toBe(name);
    expect(shades.every((s) => wearable(s.hex))).toBe(true);
    expect(shades[0].hex).not.toBe(shades[1].hex);
  });

  it("neutral garments (ivory, pale gold, black, nothing found) get a classic red and a nude", () => {
    for (const c of [[colour("#ece3cf", 0.9, true)], [colour("#d9c58f", 0.9)], [colour("#111111", 0.9, true)], []]) {
      const shades = proposeLipShades(c);
      expect(shades.map((s) => s.name)).toEqual(["Classic red", "Rose nude"]);
      expect(shades.every((s) => wearable(s.hex))).toBe(true);
    }
  });

  it("a small accent doesn't outvote a neutral garment; a large one does", () => {
    expect(proposeLipShades([colour("#ece3cf", 0.9, true), colour("#1f9d3a", 0.08)])[0].name).toBe("Classic red");
    expect(proposeLipShades([colour("#ece3cf", 0.6, true), colour("#1f9d3a", 0.4)])[0].name).toBe("Rose pink");
  });

  it("deep garments get a deeper lip than pale ones of the same family", () => {
    const deep = proposeLipShades([colour("#0b3d17", 0.9)])[0].hex;
    const pale = proposeLipShades([colour("#a8f0b6", 0.9)])[0].hex;
    const l = (h: string) => rgbToHsl(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)).l;
    expect(l(deep)).toBeLessThan(l(pale));
  });

  it("works end to end on an image", async () => {
    const r = await lipShadesForGarment(await garment("#1e5aa8"));
    expect(r.shades[0].name).toBe("Coral");
  });
});
