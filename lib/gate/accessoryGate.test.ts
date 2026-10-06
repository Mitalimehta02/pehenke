import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AccessoryService, DuplicateAccessoryError } from "../accessories/service";
import { PrismaBlobStore } from "../storage/blobs";
import { setupTestDb } from "../testing/db";
import { checkAccessoryPhoto, cropPhoto } from "./accessoryGate";

const db = setupTestDb();

/** Jewellery-like test photos: shapes drawn in gold on a backdrop. */
const svg = (body: string, bg = "#f1eff4", w = 800, h = 800) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`))
    .jpeg({ quality: 92 })
    .toBuffer();
const GOLD = "#c8961e";
const drop = (cx: number) => `<circle cx="${cx}" cy="250" r="60" fill="#c2185b"/><rect x="${cx - 70}" y="320" width="140" height="230" rx="40" fill="${GOLD}"/>`;
const oneEarring = () => svg(drop(400));
const pair = () => svg(drop(250) + drop(560));
const necklaceU = () => svg(`<path d="M150 180 Q150 620 400 620 Q650 620 650 180" fill="none" stroke="${GOLD}" stroke-width="34"/><circle cx="400" cy="640" r="46" fill="${GOLD}"/>`);
const necklaceRing = () => svg(`<circle cx="400" cy="400" r="240" fill="none" stroke="${GOLD}" stroke-width="34"/>`);
const necklaceCoiled = () => svg(`<circle cx="400" cy="400" r="250" fill="none" stroke="${GOLD}" stroke-width="26"/><circle cx="400" cy="400" r="140" fill="none" stroke="${GOLD}" stroke-width="26"/>`);

describe("earring photos", () => {
  it("approves one earring on a plain backdrop", async () => {
    expect(await checkAccessoryPhoto({ bytes: await oneEarring(), type: "earring" })).toMatchObject({ status: "approved", problems: [] });
  });

  it("a pair is not rejected: it gets a suggested crop to the left earring for the seller to confirm", async () => {
    const bytes = await pair();
    const r = await checkAccessoryPhoto({ bytes, type: "earring" });
    expect(r).toMatchObject({ status: "needs_review", problems: ["pair"] });
    const c = r.cropSuggestion!;
    // the crop holds the left earring (x 180-320) and stops before the right one (starts at x 490)
    expect(c.left).toBeLessThan(180);
    expect(c.left + c.width).toBeGreaterThan(320);
    expect(c.left + c.width).toBeLessThan(490);
    // the crop can be cut (a confirmed crop is accepted as it is, not gated again)
    const meta = await sharp(await cropPhoto(bytes, c)).metadata();
    expect([meta.width, meta.height]).toEqual([c.width, c.height]);
  });

  it("rejects three items, a busy backdrop, a tiny photo and an empty photo, each with its reason", async () => {
    expect((await checkAccessoryPhoto({ bytes: await svg(drop(160) + drop(400) + drop(640)), type: "earring" })).problems).toEqual(["several_items"]);
    const stripes = Array.from({ length: 20 }, (_, i) => `<rect x="${i * 40}" y="0" width="20" height="800" fill="#7a3b12"/>`).join("");
    expect((await checkAccessoryPhoto({ bytes: await svg(stripes + drop(400)), type: "earring" })).problems).toEqual(["busy_background"]);
    expect((await checkAccessoryPhoto({ bytes: await svg(drop(100), "#f1eff4", 240, 240), type: "earring" })).problems).toEqual(["too_small"]);
    expect((await checkAccessoryPhoto({ bytes: await svg(""), type: "earring" })).problems).toEqual(["not_found"]);
  });

  it("rejects an earring cut off at the edges", async () => {
    const r = await checkAccessoryPhoto({ bytes: await svg(`<rect x="0" y="0" width="220" height="330" fill="${GOLD}"/>`), type: "earring" });
    expect(r).toMatchObject({ status: "rejected", problems: ["cut_off"] });
  });
});

describe("necklace photos", () => {
  it("approves a necklace laid open in its worn U shape", async () => {
    expect(await checkAccessoryPhoto({ bytes: await necklaceU(), type: "necklace" })).toMatchObject({ status: "approved", problems: [] });
  });

  it("rejects a closed ring and a coiled chain: they would be drawn on the buyer as they lie", async () => {
    expect((await checkAccessoryPhoto({ bytes: await necklaceRing(), type: "necklace" })).problems).toEqual(["not_worn_shape"]);
    expect((await checkAccessoryPhoto({ bytes: await necklaceCoiled(), type: "necklace" })).problems).toEqual(["not_worn_shape"]);
  });

  it("soft shadows on a plain backdrop don't count as the item", async () => {
    const shadow = `<rect x="0" y="500" width="800" height="300" fill="#dedce2"/>`;
    const bytes = await svg(shadow + `<path d="M150 180 Q150 620 400 620 Q650 620 650 180" fill="none" stroke="${GOLD}" stroke-width="34"/><circle cx="400" cy="640" r="46" fill="${GOLD}"/>`);
    expect(await checkAccessoryPhoto({ bytes, type: "necklace" })).toMatchObject({ status: "approved" });
  });
});

describe("AccessoryService", () => {
  const setup = async () => {
    const blobs = new PrismaBlobStore(db.prisma);
    const seller = await db.prisma.seller.create({ data: { slug: "asha", name: "Asha", accessKeyHash: "x" } });
    return { blobs, seller, svc: new AccessoryService({ prisma: db.prisma, blobs }) };
  };

  it("stores the gate result with exact advice; a rejected photo is not available", async () => {
    const { svc, seller } = await setup();
    const ok = await svc.add(seller.id, { bytes: await necklaceU(), type: "necklace", label: " Temple necklace ", priceInr: 1250 });
    expect(ok).toMatchObject({ label: "Temple necklace", gateStatus: "approved", gateAdvice: null, gateBy: "rules", priceInr: 1250 });
    const bad = await svc.add(seller.id, { bytes: await necklaceCoiled(), type: "necklace", label: "Chain" });
    expect(bad.gateStatus).toBe("rejected");
    expect(bad.gateAdvice).toMatch(/Lay the necklace open in a U.*Don't coil it/);
    await expect(svc.add(seller.id, { bytes: await necklaceU(), type: "necklace", label: "Again" })).rejects.toBeInstanceOf(DuplicateAccessoryError);
  });

  it("pair photo: needs the seller's confirmation, then becomes one approved earring (original kept)", async () => {
    const { svc, seller, blobs } = await setup();
    const a = await svc.add(seller.id, { bytes: await pair(), type: "earring", label: "Jhumka" });
    expect(a).toMatchObject({ gateStatus: "needs_review" });
    expect(a.gateAdvice).toMatch(/looks like a pair.*cropped the photo to the left one/);
    expect(a.cropSuggestion).toMatchObject({ left: expect.any(Number), width: expect.any(Number) });

    const done = await svc.confirmCrop(seller.id, a.id);
    expect(done).toMatchObject({ gateStatus: "approved", gateBy: "rules+seller", originalKey: a.photoKey, gateAdvice: null });
    expect(done.photoKey).not.toBe(a.photoKey);
    expect(done.photoW).toBeLessThan(a.photoW);
    expect(await blobs.get(done.photoKey)).not.toBeNull();
    // another seller can't confirm it
    const other = await db.prisma.seller.create({ data: { slug: "other", name: "Other", accessKeyHash: "x" } });
    await expect(svc.confirmCrop(other.id, a.id)).rejects.toThrow(/not found/);
  });

  it("remove deletes an unused item with its images", async () => {
    const { svc, seller, blobs } = await setup();
    const a = await svc.add(seller.id, { bytes: await oneEarring(), type: "earring", label: "Stud" });
    await svc.remove(seller.id, a.id);
    expect(await db.prisma.accessory.count()).toBe(0);
    expect(await blobs.get(a.photoKey)).toBeNull();
  });
});
