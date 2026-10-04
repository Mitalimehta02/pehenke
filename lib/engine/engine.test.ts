import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app";
import { createTestDb } from "../testing/db";
import { FakeYouCam } from "../testing/fakeYoucam";
import { addBuyerPhoto, personImage, seedBasics } from "../testing/fixtures";
import { BTN, btn, type ChatMessage, type Incoming, type Outgoing } from "./types";
import sharp from "sharp";

let db: Awaited<ReturnType<typeof createTestDb>>;
let fake: FakeYouCam;
let app: App;
let seed: Awaited<ReturnType<typeof seedBasics>>;

const CAPS = { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit: 18 };

beforeEach(async () => {
  db = await createTestDb();
  fake = new FakeYouCam();
  app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: CAPS });
  seed = await seedBasics(db.prisma, app.blobs);
});
afterEach(async () => {
  await app.tryOns.idle();
  await db.close();
});

const base = (buyer = "cookie-1") => ({ channel: "web" as const, sellerSlug: "asha-sarees", buyerExternalId: buyer });
const out = (r: { messages: ChatMessage[] }) => r.messages.filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
const say = async (text: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "text", text }));
const tap = async (id: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "button", id }));
const send = async (bytes: Uint8Array, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "image", bytes } as Incoming));
const texts = (o: Outgoing[]) => o.map((m) => ("text" in m ? m.text : "caption" in m ? m.caption : "")).join("\n");
const buttonIds = (o: Outgoing[]) => o.flatMap((m) => ("buttons" in m && m.buttons ? m.buttons.map((b) => b.id) : []));
const choiceIds = (o: Outgoing[]) => o.flatMap((m) => (m.kind === "choices" ? m.choices.map((c) => c.id) : []));
const state = async (buyer = "cookie-1") =>
  (await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } })).state;
const lastOut = async (buyer = "cookie-1") => {
  const conv = await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } });
  return (await app.engine.messagesSince(conv.id)).filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
};

/** Consent + upload + confirm full body: ends in PICK_GARMENT. */
async function toPickGarment(buyer?: string) {
  await say("hi", buyer);
  await tap(BTN.agree, buyer);
  const o = await send(await personImage(), buyer);
  const confirm = buttonIds(o).find((id) => id.startsWith(`${BTN.yesFull}:`))!;
  return tap(confirm, buyer);
}

describe("buyer flow", () => {
  it("greeting -> consent -> photo -> pick -> try-on -> preview -> order -> seller approves -> card", async () => {
    const hi = await say("hi");
    expect(texts(hi)).toMatch(/Welcome to Asha Sarees/);
    expect(texts(hi)).toMatch(/deleted automatically after 30 days/);
    expect(buttonIds(hi)).toEqual([BTN.agree, BTN.decline]);
    expect(await state()).toBe("AWAIT_CONSENT");

    expect(await state()).toBe("AWAIT_CONSENT");
    await tap(BTN.agree);
    expect(await state()).toBe("AWAIT_PHOTO");

    const confirmAsk = await send(await personImage());
    expect(texts(confirmAsk)).toMatch(/head to your feet/);
    const pick = await tap(buttonIds(confirmAsk)[0]);
    expect(choiceIds(pick)).toEqual([btn(BTN.garment, seed.garment.id)]);
    expect(await state()).toBe("PICK_GARMENT");

    const working = await tap(btn(BTN.garment, seed.garment.id));
    expect(working[0]).toEqual({ kind: "status", status: "working" });
    expect(await state()).toBe("TRYON_RUNNING");
    expect(texts(await say("hello?"))).toMatch(/Still working/);

    await app.tryOns.idle();
    const after = await lastOut();
    const preview = after.find((m) => m.kind === "image")!;
    expect(preview).toMatchObject({ kind: "image" });
    expect(texts([preview])).toMatch(/Saree as ordered\. Styling, accessories and other garments shown are illustrative\./);
    expect(await state()).toBe("PREVIEW");

    const ordered = await tap(BTN.order);
    expect(texts(ordered)).toMatch(/sent your order to Asha Sarees/);
    expect(ordered.find((m) => m.kind === "link")).toEqual({ kind: "link", label: "Demo: open seller view", href: "/seller/asha-sarees" });
    expect(await state()).toBe("AWAIT_SELLER");

    const order = await db.prisma.order.findFirstOrThrow();
    expect(order).toMatchObject({ cardStatus: "pending_seller", outcome: "pending" });
    await app.orders.decide(seed.seller.id, order.id, "approve");
    const card = (await lastOut()).find((m) => m.kind === "card")!;
    expect(card).toMatchObject({ kind: "card", title: "Order confirmed" });
    expect((card as { lines: string[] }).lines.join(" ")).toMatch(/saree · ₹1,899/);
    expect(await state()).toBe("ORDERED");

    await app.orders.setOutcome(seed.seller.id, order.id, "delivered");
    expect(await db.prisma.order.findFirstOrThrow()).toMatchObject({ outcome: "delivered" });
    expect((await db.prisma.order.findFirstOrThrow()).outcomeAt).not.toBeNull();
  });

  it("opening the chat greets once, without recording a buyer message", async () => {
    const first = await app.engine.handle({ ...base(), kind: "open" });
    expect(first.messages.every((m) => m.direction === "out")).toBe(true);
    expect(texts(out(first))).toMatch(/Welcome to Asha Sarees/);
    expect((await app.engine.handle({ ...base(), kind: "open" })).messages).toEqual([]);
    expect(await state()).toBe("AWAIT_CONSENT");
  });

  it("declining consent stores nothing; 'hi' starts over", async () => {
    await say("hi");
    expect(texts(await tap(BTN.decline))).toMatch(/Nothing was saved/);
    expect(await state()).toBe("DECLINED");
    expect(texts(await say("what"))).toMatch(/Nothing was saved/);
    await say("hi");
    expect(await state()).toBe("AWAIT_CONSENT");
  });

  it("does not store a photo sent before consent", async () => {
    await say("hi");
    const o = await send(await personImage());
    expect(texts(o)).toMatch(/tap "I agree"/);
    expect(await db.prisma.buyerPhoto.count()).toBe(0);
    expect(await db.prisma.blob.count()).toBe(1); // only the garment
  });

  it("asks again for wrong photos and stores none of them", async () => {
    await say("hi");
    await tap(BTN.agree);
    const landscape = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#888" } }).jpeg().toBuffer();
    expect(texts(await send(landscape))).toMatch(/upright \(portrait\)/);
    const tiny = await sharp({ create: { width: 200, height: 400, channels: 3, background: "#888" } }).jpeg().toBuffer();
    expect(texts(await send(tiny))).toMatch(/too small/);
    expect(await db.prisma.buyerPhoto.count()).toBe(0);
    expect(await state()).toBe("AWAIT_PHOTO");
  });

  it("'No, I'll retake' marks the photo not full-body and asks again", async () => {
    await say("hi");
    await tap(BTN.agree);
    await send(await personImage());
    expect(texts(await tap(BTN.retake))).toMatch(/new photo/);
    expect(await db.prisma.buyerPhoto.findFirstOrThrow()).toMatchObject({ framing: "chest", accepted: false });
    expect(await state()).toBe("AWAIT_PHOTO");
  });

  it("sample photos: offered after consent, pre-rendered results are served from cache", async () => {
    const sample = await db.prisma.buyerPhoto.update({
      where: { id: (await addBuyerPhoto(db.prisma, app.blobs, null)).id },
      data: { sampleName: "Sample model 1" },
    });
    // Pre-render once (no buyer)
    await app.tryOns.request({ garmentId: seed.garment.id, buyerPhotoId: sample.id, buyerId: null });
    await app.tryOns.idle();
    expect(fake.starts).toHaveLength(1);

    await say("hi");
    const ask = await tap(BTN.agree);
    expect(choiceIds(ask)).toEqual([btn(BTN.sample, sample.id)]);
    await tap(btn(BTN.sample, sample.id));
    const preview = await tap(btn(BTN.garment, seed.garment.id));
    expect(preview.find((m) => m.kind === "image")).toBeTruthy();
    expect(await state()).toBe("PREVIEW");
    expect(fake.starts).toHaveLength(1); // no new render
  });

  it("refuses politely when the buyer's daily render cap is hit", async () => {
    app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: { ...CAPS, buyerDailyRenders: 1 } });
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await tap(BTN.newPhoto);
    const o = await send(await personImage("#22aa55"));
    await tap(buttonIds(o)[0]);
    expect(texts(await tap(btn(BTN.garment, seed.garment.id)))).toMatch(/1 new previews today, which is the daily limit/);
    expect(fake.starts).toHaveLength(1);
  });

  it("refuses politely when the app's daily unit cap is hit", async () => {
    app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: { ...CAPS, youcamDailyUnits: 1 } });
    await toPickGarment();
    expect(texts(await tap(btn(BTN.garment, seed.garment.id)))).toMatch(/paused for today/);
    expect(fake.starts).toHaveLength(0);
  });

  it("tells the buyer when the preview was blocked", async () => {
    fake.opts.render = "unchanged";
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    expect(texts(await lastOut())).toMatch(/couldn't make a good preview/);
    expect(await state()).toBe("PICK_GARMENT");
    expect(await db.prisma.tryOn.findFirstOrThrow()).toMatchObject({ verdict: "block", unitsWasted: 2 });
  });

  it("tells the buyer when the seller rejects", async () => {
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await tap(BTN.order);
    const order = await db.prisma.order.findFirstOrThrow();
    await app.orders.decide(seed.seller.id, order.id, "reject", "out of stock in your size");
    expect(texts(await lastOut())).toMatch(/couldn't confirm this order: out of stock in your size/);
    expect(await state()).toBe("PICK_GARMENT");
  });

  it("a waiting chat gets its result after a server restart", async () => {
    // First process dies mid-poll.
    const dying = createApp({
      prisma: db.prisma,
      caps: CAPS,
      youcam: (l) => {
        const c = fake.client(l);
        c.clothesV3.poll = async () => {
          throw new Error("process killed");
        };
        return c;
      },
    });
    await dying.engine.handle({ ...base(), kind: "text", text: "hi" });
    await dying.engine.handle({ ...base(), kind: "button", id: BTN.agree });
    const o = out(await dying.engine.handle({ ...base(), kind: "image", bytes: await personImage() }));
    await dying.engine.handle({ ...base(), kind: "button", id: buttonIds(o)[0] });
    await dying.engine.handle({ ...base(), kind: "button", id: btn(BTN.garment, seed.garment.id) });
    await dying.tryOns.idle();
    expect(await state()).toBe("TRYON_RUNNING");

    // New process: resume on start.
    await app.tryOns.resumeAll();
    await app.tryOns.idle();
    expect(await state()).toBe("PREVIEW");
    expect(fake.starts).toHaveLength(1);
  });
});

describe("consent and deletion", () => {
  it("'delete my photos' removes photos, renders and blobs here and at YouCam, and says so", async () => {
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await tap(BTN.order);
    const tryOn = await db.prisma.tryOn.findFirstOrThrow();
    const photo = await db.prisma.buyerPhoto.findFirstOrThrow();

    const o = await say("delete my photos");
    expect(texts(o)).toMatch(/Deleted from our servers: 1 photo and 1 try-on image\. YouCam .* confirmed/);
    expect(fake.deletes).toEqual([tryOn.taskId]);
    expect(await db.prisma.buyerPhoto.count()).toBe(0);
    expect(await db.prisma.tryOn.count()).toBe(0);
    expect(await app.blobs.get(photo.blobKey)).toBeNull();
    expect(await app.blobs.get(tryOn.outputKey!)).toBeNull();
    expect(await app.blobs.get(seed.garment.photoKey)).not.toBeNull();
    // the seller keeps the order, without the image
    expect(await db.prisma.order.findFirstOrThrow()).toMatchObject({ tryOnId: null });
    // the preview in chat history is replaced
    const conv = await db.prisma.conversation.findFirstOrThrow();
    const history = await app.engine.messagesSince(conv.id);
    expect(history.some((m) => (m.body as { mediaKey?: string }).mediaKey === tryOn.outputKey)).toBe(false);
    expect(history.some((m) => (m.body as { text?: string }).text === "[photo deleted]")).toBe(true);
    // consent stays, so they can send a new photo
    expect(await state()).toBe("AWAIT_PHOTO");
  });

  it("is honest when YouCam already removed the task", async () => {
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    const t = await db.prisma.tryOn.findFirstOrThrow();
    // simulate YouCam's own 24h cleanup
    await fake.client().deleteTask(t.taskId!);
    fake.deletes.length = 0;
    expect(texts(await say("delete my photos"))).toMatch(/confirmed they're deleted/);
  });

  it("never deletes seeded sample photos", async () => {
    const sample = await addBuyerPhoto(db.prisma, app.blobs, null);
    await say("hi");
    await tap(BTN.agree);
    await tap(btn(BTN.sample, sample.id));
    expect(texts(await say("delete my photos"))).toMatch(/no photos stored/);
    expect(await db.prisma.buyerPhoto.count()).toBe(1);
  });

  it("'stop' deletes everything and withdraws consent", async () => {
    await toPickGarment();
    expect(texts(await say("stop"))).toMatch(/withdrawn consent/);
    expect(await db.prisma.buyerPhoto.count()).toBe(0);
    expect(await db.prisma.consent.findFirstOrThrow()).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await state()).toBe("NEW");
    expect(buttonIds(await say("hi"))).toEqual([BTN.agree, BTN.decline]);
  });

  it("retention: purges photos and renders older than 30 days only", async () => {
    await toPickGarment();
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    const old = await db.prisma.buyerPhoto.findFirstOrThrow();
    await db.prisma.buyerPhoto.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * 864e5) } });
    await addBuyerPhoto(db.prisma, app.blobs, old.buyerId, "#22aa55"); // recent
    expect(await app.consent.purgeExpired()).toEqual({ buyers: 1, photos: 1, renders: 1 });
    expect(await db.prisma.buyerPhoto.count()).toBe(1);
  });
});
