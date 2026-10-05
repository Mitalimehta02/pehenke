import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app";
import { resetDemo } from "../demo/reset";
import { BTN, btn, type Outgoing } from "../engine/types";
import { storeImage } from "../storage/blobs";
import { setupTestDb } from "../testing/db";
import { FakeYouCam } from "../testing/fakeYoucam";
import { addBuyerPhoto, garmentImage, personImage } from "../testing/fixtures";
import { funnel, storageStats, unitStats } from "./dashboard";

const db = setupTestDb();
let app: App;
let fake: FakeYouCam;

beforeEach(() => {
  fake = new FakeYouCam();
  app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: { youcamDailyUnits: 100, buyerDailyRenders: 10, geminiDailyLimit: 18 } });
});

async function shop(slug: string, isDemo: boolean, credit: boolean) {
  const seller = await db.prisma.seller.create({ data: { slug, name: slug, accessKeyHash: "x", isDemo } });
  const g = await storeImage(app.blobs, "garment", await garmentImage(isDemo ? "#b0124a" : "#1a7f4b"));
  const garment = await db.prisma.garment.create({
    data: {
      sellerId: seller.id,
      label: "saree",
      category: "full_body",
      photoType: "flatlay",
      photoKey: g.key,
      photoHash: g.hash,
      photoW: g.width,
      photoH: g.height,
      gateStatus: "approved",
      credit: credit ? { source: "seed" } : undefined,
    },
  });
  return { seller, garment };
}

/** A buyer goes all the way to an approved, delivered order with an uploaded photo. */
async function fullOrder(slug: string, buyer: string, garmentId: string, sellerId: string) {
  const base = { channel: "web" as const, sellerSlug: slug, buyerExternalId: buyer };
  await app.engine.handle({ ...base, kind: "text", text: "hi" });
  await app.engine.handle({ ...base, kind: "button", id: BTN.agree });
  const r = await app.engine.handle({ ...base, kind: "image", bytes: await personImage(buyer === "b1" ? "#884422" : "#aa7722") });
  const confirm = r.messages.flatMap((m) => ((m.body as Outgoing & { buttons?: { id: string }[] }).buttons ?? []).map((b) => b.id)).find((id) => id.startsWith(BTN.yesFull))!;
  await app.engine.handle({ ...base, kind: "button", id: confirm });
  await app.engine.handle({ ...base, kind: "button", id: btn(BTN.garment, garmentId) });
  await app.tryOns.idle();
  await app.engine.handle({ ...base, kind: "button", id: BTN.order });
  const order = await db.prisma.order.findFirstOrThrow({ where: { sellerId } });
  await app.orders.decide(sellerId, order.id, "approve");
  await app.orders.setOutcome(sellerId, order.id, "delivered");
}

describe("seller dashboard", () => {
  it("counts only the seller's own activity: demo activity never reaches a real seller's funnel", async () => {
    const demo = await shop("demo", true, true);
    const real = await shop("real", false, true);
    await fullOrder("demo", "b1", demo.garment.id, demo.seller.id);

    const empty = { chats: 0, consented: 0, photos: 0, previews: 0, orders: 0, approved: 0, delivered: 0, refused: 0, cancelled: 0 };
    expect(await funnel(db.prisma, real.seller.id)).toEqual(empty);
    expect(await funnel(db.prisma, demo.seller.id)).toEqual({ chats: 1, consented: 1, photos: 1, previews: 1, orders: 1, approved: 1, delivered: 1, refused: 0, cancelled: 0 });
    expect(await unitStats(db.prisma, real.seller.id)).toMatchObject({ units: 0, renders: 0 });
    expect(await unitStats(db.prisma, demo.seller.id)).toMatchObject({ units: 2, wasted: 0, wastedPct: 0, renders: 1 });
  });

  it("reports the wasted-unit rate from blocked renders", async () => {
    const real = await shop("real", false, true);
    fake.opts.render = "unchanged";
    await fullOrder("real", "b1", real.garment.id, real.seller.id).catch(() => undefined); // the order step fails: preview was blocked
    expect(await unitStats(db.prisma, real.seller.id)).toMatchObject({ units: 2, wasted: 2, wastedPct: 100, blocked: 1 });
  });

  it("reports database and image storage size", async () => {
    await shop("real", false, true);
    const s = await storageStats(db.prisma);
    expect(s.dbBytes).toBeGreaterThan(0);
    expect(s.blobCount).toBe(1);
  });
});

describe("demo reset", () => {
  it("removes visitor data, keeps seeded garments and cached sample renders", async () => {
    const demo = await shop("demo", true, true);
    const real = await shop("real", false, true);
    const sample = await addBuyerPhoto(db.prisma, app.blobs, null);
    await app.tryOns.request({ garmentId: demo.garment.id, buyerPhotoId: sample.id, buyerId: null });
    await app.tryOns.idle();
    await fullOrder("demo", "b1", demo.garment.id, demo.seller.id);
    await fullOrder("real", "b2", real.garment.id, real.seller.id);
    // a garment a visitor added on the demo seller page (no credit)
    const extra = await storeImage(app.blobs, "garment", await garmentImage("#123456"));
    await db.prisma.garment.create({
      data: { sellerId: demo.seller.id, label: "test", category: "upper_body", photoType: "hanger", photoKey: extra.key, photoHash: extra.hash, photoW: 1, photoH: 1 },
    });

    expect(await resetDemo(app, demo.seller.id)).toEqual({ chats: 1, orders: 1, photos: 1, renders: 1, garments: 1 });

    expect(await db.prisma.garment.count({ where: { sellerId: demo.seller.id } })).toBe(1); // seeded one kept
    expect(await db.prisma.tryOn.count({ where: { buyerPhotoId: sample.id } })).toBe(1); // sample render kept
    expect(await funnel(db.prisma, demo.seller.id)).toMatchObject({ chats: 0, orders: 0, photos: 0 });
    // the real seller is untouched
    expect(await funnel(db.prisma, real.seller.id)).toMatchObject({ chats: 1, orders: 1, delivered: 1 });
    expect(await app.blobs.get(extra.key)).toBeNull();
  });

  it("refuses to reset a real seller", async () => {
    const real = await shop("real", false, true);
    await expect(resetDemo(app, real.seller.id)).rejects.toThrow(/only available for the demo seller/);
  });
});
