import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { personImage } from "../testing/fixtures";
import { cropSize, cutCrop, headChanges, headCrop, MisalignedResultError, pasteChanged, HEAD_CHANGED_MAX_PCT } from "./crop";
import { findFaces, pickFace, type Face } from "./faceFinder";

/** The head of the personImage fixture (600x1000): circle at (300, 100), radius 66. */
const FACE: Face = { cx: 0.5, cy: 0.1, size: 0.22, score: 100 };

const raw = async (b: Uint8Array) => sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
/** A detailed (non-flat) full-body-like image, so any softening would show up as changed pixels. */
async function textured(w = 600, h = 1000) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf.set([(x * 7 + y * 3) % 256, (x * 13) % 256, (y * 11 + x) % 256], (y * w + x) * 3);
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("headCrop", () => {
  it("frames head and shoulders around the face and enlarges it for the API", () => {
    const box = headCrop(FACE, 600, 1000)!;
    expect(box).toMatchObject({ left: 76, top: 0, width: 449, height: 561 });
    // sent at 960x1200: both sides multiples of 16 (the API changes odd sizes, which breaks pixel alignment)
    expect(cropSize(box)).toEqual({ width: 960, height: 1200 });
    expect(cropSize({ left: 0, top: 0, width: 468, height: 585, scale: 2.05 })).toEqual({ width: 960, height: 1200 });
    expect(cropSize({ left: 0, top: 0, width: 1003, height: 1251, scale: 1 })).toEqual({ width: 1008, height: 1248 });
    // the face is about 29% of the crop width: well above what the necklace feature needs
    expect((FACE.size * 600) / box.width).toBeGreaterThan(0.25);
  });

  it("stays inside the image, and refuses a photo with nothing below the face", () => {
    const edge = headCrop({ ...FACE, cx: 0.05 }, 600, 1000)!;
    expect(edge.left).toBe(0);
    expect(edge.left + edge.width).toBeLessThanOrEqual(600);
    expect(headCrop({ cx: 0.5, cy: 0.9, size: 0.3, score: 50 }, 600, 700)).toBeNull();
  });

  it("doesn't enlarge a crop that is already large", () => {
    expect(headCrop(FACE, 3000, 5000)!.scale).toBe(1);
  });
});

describe("pickFace", () => {
  it("one face, none, or several comparable ones", () => {
    expect(pickFace([FACE])).toEqual({ face: FACE });
    expect(pickFace([])).toEqual({ problem: "no_face" });
    expect(pickFace([FACE, { ...FACE, cx: 0.8, score: 80 }])).toEqual({ problem: "several_faces" });
    // a weak or tiny second detection is background noise, not another person
    expect(pickFace([FACE, { ...FACE, cx: 0.8, score: 12 }])).toEqual({ face: FACE });
    expect(pickFace([FACE, { ...FACE, size: 0.04, score: 90 }])).toEqual({ face: FACE });
  });
});

describe("findFaces (bundled detector)", () => {
  it("finds no face in a picture without one", async () => {
    expect(await findFaces(await textured(400, 400))).toEqual([]);
    const flat = await sharp({ create: { width: 500, height: 700, channels: 3, background: "#d8d0c0" } }).jpeg().toBuffer();
    expect(await findFaces(flat)).toEqual([]);
  });
});

describe("headChanges", () => {
  it("clean when the try-on changed only the clothes", async () => {
    const original = await personImage();
    // "try-on": recolour the torso, well below the ears
    const tryOn = await sharp(original).composite([{ input: { create: { width: 420, height: 700, channels: 3, background: "#b0124a" } }, left: 90, top: 190 }]).jpeg().toBuffer();
    expect(await headChanges(original, tryOn, FACE)).toEqual({ earPct: 0, foreheadPct: 0, clear: true });
  });

  it("not clean when something appears at an ear or on the forehead", async () => {
    const original = await personImage();
    const overEar = await sharp(original).composite([{ input: { create: { width: 60, height: 90, channels: 3, background: "#e0b020" } }, left: 215, top: 100 }]).jpeg().toBuffer();
    const ear = await headChanges(original, overEar, FACE);
    expect(ear.clear).toBe(false);
    expect(ear.earPct).toBeGreaterThan(HEAD_CHANGED_MAX_PCT);
    const tikka = await sharp(original).composite([{ input: { create: { width: 40, height: 40, channels: 3, background: "#e0b020" } }, left: 280, top: 15 }]).jpeg().toBuffer();
    const fh = await headChanges(original, tikka, FACE);
    expect(fh.clear).toBe(false);
    expect(fh.foreheadPct).toBeGreaterThan(HEAD_CHANGED_MAX_PCT);
  });
});

describe("pasteChanged", () => {
  it("changes only the pixels the API changed: everything else is bit-identical to the base", async () => {
    const base = await textured();
    const box = headCrop(FACE, 600, 1000)!;
    const before = await cutCrop(base, box);
    const { width: cw, height: ch } = cropSize(box);
    // "API result": a red patch (lips) in the enlarged crop, nothing else touched
    const patch = { left: Math.round(cw * 0.44), top: Math.round(ch * 0.33), width: Math.round(cw * 0.12), height: Math.round(ch * 0.03) };
    const after = await sharp(before).composite([{ input: { create: { width: patch.width, height: patch.height, channels: 3, background: "#b02a1e" } }, left: patch.left, top: patch.top }]).png().toBuffer();

    const r = await pasteChanged(base, box, before, after);
    expect(r.changedShare).toBeGreaterThan(0.002);
    expect(r.changedShare).toBeLessThan(0.006);
    const a = await raw(base);
    const b = await raw(r.full);
    expect([b.info.width, b.info.height]).toEqual([600, 1000]);

    // patch position in the base image, with a few pixels of soft edge allowed around it (6 px)
    const k = box.scale;
    const px0 = box.left + patch.left / k - 6, px1 = box.left + (patch.left + patch.width) / k + 6;
    const py0 = box.top + patch.top / k - 6, py1 = box.top + (patch.top + patch.height) / k + 6;
    let outsideChanged = 0;
    let insideRed = 0;
    for (let y = 0; y < 1000; y++) {
      for (let x = 0; x < 600; x++) {
        const i = (y * 600 + x) * 3;
        const inside = x >= px0 && x <= px1 && y >= py0 && y <= py1;
        if (!inside && (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2])) outsideChanged++;
        if (inside && b.data[i] > 150 && b.data[i + 1] < 80 && b.data[i + 2] < 70) insideRed++;
      }
    }
    // no softening anywhere else, although the crop was enlarged x2 and reduced again
    expect(outsideChanged).toBe(0);
    expect(insideRed).toBeGreaterThan(200);
  });

  it("refuses a result that differs across most of the crop (misaligned or altered everywhere)", async () => {
    const base = await textured();
    const box = headCrop(FACE, 600, 1000)!;
    const before = await cutCrop(base, box);
    // what a 1-pixel size change does: everything shifts
    const shifted = await sharp(before).extract({ left: 3, top: 3, width: 950, height: 1190 }).resize(960, 1200, { fit: "fill" }).png().toBuffer();
    await expect(pasteChanged(base, box, before, shifted)).rejects.toBeInstanceOf(MisalignedResultError);
  });

  it("an unchanged result gives back the base exactly", async () => {
    const base = await textured();
    const box = headCrop(FACE, 600, 1000)!;
    const before = await cutCrop(base, box);
    const r = await pasteChanged(base, box, before, before);
    expect(r.changedShare).toBe(0);
    expect((await raw(r.full)).data.equals((await raw(base)).data)).toBe(true);
  });
});
