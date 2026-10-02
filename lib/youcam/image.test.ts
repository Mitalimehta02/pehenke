import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CLOTHES_V3_IMAGE } from "./features/clothesV3";
import { SKIN_TONE_IMAGE } from "./features/skinTone";
import { ImageRejectedError, prepareImage } from "./image";

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#a0522d" } });

describe("prepareImage", () => {
  it("applies EXIF rotation and strips metadata", async () => {
    // 800x600 stored with orientation 6 = displays as 600x800
    const src = await solid(800, 600).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await prepareImage(src, "selfie.jpg", CLOTHES_V3_IMAGE);
    expect([out.width, out.height]).toEqual([600, 800]);
    expect(out.changes.join()).toContain("rotated");
    expect((await sharp(out.bytes).metadata()).orientation).toBeUndefined();
  });

  it("converts png to jpg for skin tone (jpg only) and keeps png for clothes", async () => {
    const png = await solid(600, 600).png().toBuffer();
    expect((await prepareImage(png, "a.png", SKIN_TONE_IMAGE)).contentType).toBe("image/jpg");
    expect((await prepareImage(png, "a.png", SKIN_TONE_IMAGE)).fileName).toBe("a.jpg");
    expect((await prepareImage(png, "a.png", CLOTHES_V3_IMAGE)).contentType).toBe("image/png");
  });

  it("shrinks images above the max side", async () => {
    const big = await solid(5000, 3000).jpeg().toBuffer();
    const out = await prepareImage(big, "big.jpg", CLOTHES_V3_IMAGE);
    expect(Math.max(out.width, out.height)).toBe(4096);
  });

  it("rejects images below the minimum instead of upscaling", async () => {
    const small = await solid(400, 300).jpeg().toBuffer();
    await expect(prepareImage(small, "small.jpg", CLOTHES_V3_IMAGE)).rejects.toBeInstanceOf(ImageRejectedError);
  });
});
