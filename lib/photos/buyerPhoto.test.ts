import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkBuyerPhoto } from "./buyerPhoto";

const img = (w: number, h: number, orientation?: number) => {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: "#888" } }).jpeg();
  if (orientation) p = p.withMetadata({ orientation });
  return p.toBuffer();
};

describe("checkBuyerPhoto", () => {
  it("accepts a portrait photo above the minimum", async () => {
    expect(await checkBuyerPhoto(await img(600, 1000))).toEqual({ ok: true, width: 600, height: 1000 });
  });

  it("rejects landscape photos", async () => {
    expect(await checkBuyerPhoto(await img(1000, 600))).toMatchObject({ ok: false, reason: "landscape" });
  });

  it("uses EXIF orientation (a sideways-stored portrait is portrait)", async () => {
    expect(await checkBuyerPhoto(await img(1000, 600, 6))).toMatchObject({ ok: true, width: 600, height: 1000 });
  });

  it("rejects photos below YouCam's 512x384 minimum", async () => {
    expect(await checkBuyerPhoto(await img(300, 500))).toMatchObject({ ok: false, reason: "too_small" });
  });

  it("rejects non-images", async () => {
    expect(await checkBuyerPhoto(new TextEncoder().encode("hello"))).toEqual({ ok: false, reason: "not_an_image" });
  });
});
