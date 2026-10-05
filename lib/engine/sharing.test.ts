import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app";
import { VoteClosedError } from "../family/service";
import { setupTestDb } from "../testing/db";
import { FakeYouCam } from "../testing/fakeYoucam";
import { addBuyerPhoto, garmentImage, personImage, seedBasics } from "../testing/fixtures";
import { storeImage } from "../storage/blobs";
import { BTN, btn, type ChatMessage, type Incoming, type Outgoing } from "./types";

/** Shared links: outfit links (preselect), the phone step, family votes, and their deletion. */

const db = setupTestDb();
let fake: FakeYouCam;
let app: App;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let clock: Date;

const CAPS = { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit: 18 };
const DAY = 864e5;

beforeEach(async () => {
  fake = new FakeYouCam();
  clock = new Date();
  app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: CAPS, baseUrl: "https://shop.example", now: () => clock });
  seed = await seedBasics(db.prisma, app.blobs);
});
afterEach(async () => {
  await app.tryOns.idle();
});

const base = (buyer = "cookie-1") => ({ channel: "web" as const, sellerSlug: "asha-sarees", buyerExternalId: buyer });
const out = (r: { messages: ChatMessage[] }) => r.messages.filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
const say = async (text: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "text", text }));
const tap = async (id: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "button", id }));
const open = async (garmentId?: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "open", garmentId }));
const send = async (bytes: Uint8Array, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "image", bytes } as Incoming));
const texts = (o: Outgoing[]) => o.map((m) => ("text" in m ? m.text : "caption" in m ? m.caption : "")).join("\n");
const buttonIds = (o: Outgoing[]) => o.flatMap((m) => ("buttons" in m && m.buttons ? m.buttons.map((b) => b.id) : []));
const choiceIds = (o: Outgoing[]) => o.flatMap((m) => (m.kind === "choices" ? m.choices.map((c) => c.id) : []));
const state = async (buyer = "cookie-1") => (await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } })).state;
const history = async (buyer = "cookie-1") => {
  const conv = await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } });
  return (await app.engine.messagesSince(conv.id)).filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
};

async function secondGarment() {
  const g = await storeImage(app.blobs, "garment", await garmentImage("#1a7a3a"));
  return db.prisma.garment.create({
    data: { sellerId: seed.seller.id, label: "green kurti", category: "upper_body", photoType: "mannequin", priceInr: 999, photoKey: g.key, photoHash: g.hash, photoW: g.width, photoH: g.height, gateStatus: "approved", gateBy: "rules" },
  });
}

async function consentAndPhoto(buyer?: string) {
  await tap(BTN.agree, buyer);
  const o = await send(await personImage(), buyer);
  return tap(buttonIds(o).find((id) => id.startsWith(`${BTN.yesFull}:`))!, buyer);
}

async function toPreview(buyer?: string) {
  await say("hi", buyer);
  await consentAndPhoto(buyer);
  await tap(btn(BTN.garment, seed.garment.id), buyer);
  await app.tryOns.idle();
  expect(await state(buyer)).toBe("PREVIEW");
}

describe("shared outfit link (preselect)", () => {
  it("a new chat opened from an outfit link shows that outfit, then renders it as soon as the photo is confirmed", async () => {
    const kurti = await secondGarment();
    const hi = await open(kurti.id);
    expect(texts(hi)).toMatch(/Welcome to Asha Sarees[\s\S]*You asked about: green kurti · ₹999/);
    expect(hi.find((m) => m.kind === "image")).toMatchObject({ mediaKey: kurti.photoKey });
    expect(fake.starts).toHaveLength(0); // opening a link never spends units

    const working = await consentAndPhoto();
    expect(working[0]).toEqual({ kind: "status", status: "working" });
    expect(await state()).toBe("TRYON_RUNNING");
    await app.tryOns.idle();
    expect(await db.prisma.tryOn.findFirstOrThrow()).toMatchObject({ garmentId: kurti.id, category: "upper_body" });
    expect(await state()).toBe("PREVIEW");
    // the preselect is used once: the next photo lists all outfits
    expect((await db.prisma.conversation.findFirstOrThrow()).context).not.toHaveProperty("wantGarmentId");
  });

  it("ignores links to outfits that are hidden, unchecked or from another shop", async () => {
    const kurti = await secondGarment();
    await db.prisma.garment.update({ where: { id: kurti.id }, data: { active: false } });
    const other = await db.prisma.seller.create({ data: { slug: "other", name: "Other", accessKeyHash: "x" } });
    const g = seed.garment;
    const foreign = await db.prisma.garment.create({
      data: { sellerId: other.id, label: "x", category: g.category, photoType: g.photoType, photoKey: g.photoKey, photoHash: g.photoHash, photoW: g.photoW, photoH: g.photoH, gateStatus: "approved" },
    });

    expect(texts(await open(kurti.id))).not.toMatch(/You asked about/);
    expect(texts(await open(foreign.id, "cookie-2"))).not.toMatch(/You asked about/);
    const pick = await consentAndPhoto();
    expect(choiceIds(pick)).toEqual([btn(BTN.garment, seed.garment.id)]);
  });

  it("an existing chat offers the linked outfit with one tap, once, without rendering it", async () => {
    const kurti = await secondGarment();
    await say("hi");
    await consentAndPhoto();
    expect(await state()).toBe("PICK_GARMENT");

    const offer = await open(kurti.id);
    expect(texts(offer)).toMatch(/You opened the link for green kurti/);
    expect(choiceIds(offer)).toEqual([btn(BTN.garment, kurti.id)]);
    expect(fake.starts).toHaveLength(0);
    expect(await open(kurti.id)).toEqual([]); // same link reopened: nothing new

    await tap(btn(BTN.garment, kurti.id));
    await app.tryOns.idle();
    expect(fake.starts).toHaveLength(1);
  });

  it("before consent, a link opened later is remembered for after the photo", async () => {
    const kurti = await secondGarment();
    await say("hi");
    expect(texts(await open(kurti.id))).toMatch(/You asked about: green kurti/);
    await consentAndPhoto();
    await app.tryOns.idle();
    expect(await db.prisma.tryOn.findFirstOrThrow()).toMatchObject({ garmentId: kurti.id });
  });
});

describe("phone step", () => {
  it("skip creates the order without a number; buttons still work while asked", async () => {
    await toPreview();
    await tap(BTN.order);
    expect(await state()).toBe("AWAIT_PHONE");
    // changing their mind: back to the outfits, no order
    const list = await tap(BTN.tryAnother);
    expect(choiceIds(list)).toEqual([btn(BTN.garment, seed.garment.id)]);
    expect(await db.prisma.order.count()).toBe(0);

    await tap(btn(BTN.garment, seed.garment.id)); // cached render: straight to preview
    await tap(BTN.order);
    expect(texts(await tap(BTN.skipPhone))).toMatch(/to confirm\. You'll get your confirmation card here\.(\n|$)/);
    expect(await db.prisma.order.findFirstOrThrow()).toMatchObject({ buyerWhatsapp: null });
    expect(await state()).toBe("AWAIT_SELLER");
  });

  it("accepts international numbers", async () => {
    await toPreview();
    await tap(BTN.order);
    await say("+44 7700 900123");
    expect((await db.prisma.order.findFirstOrThrow()).buyerWhatsapp).toBe("+447700900123");
  });
});

describe("order card for WhatsApp", () => {
  async function approvedOrder() {
    await toPreview();
    await tap(BTN.order);
    await say("98765 43210");
    const order = await db.prisma.order.findFirstOrThrow();
    await app.orders.decide(seed.seller.id, order.id, "approve");
    return db.prisma.order.findFirstOrThrow();
  }

  it("records the first send and the dispatch, once each", async () => {
    const order = await approvedOrder();
    expect(order.cardSentAt).toBeNull();
    const t1 = clock;
    await app.orders.markCardSent(seed.seller.id, order.id);
    clock = new Date(t1.getTime() + 3600_000);
    await app.orders.markCardSent(seed.seller.id, order.id); // resend keeps the first time
    await app.orders.markDispatched(seed.seller.id, order.id);
    const after = await db.prisma.order.findFirstOrThrow();
    expect(after.cardSentAt).toEqual(t1);
    expect(after.dispatchedAt).toEqual(clock);
  });

  it("only the order's seller can mark it, and only approved orders", async () => {
    await toPreview();
    await tap(BTN.order);
    await tap(BTN.skipPhone);
    const order = await db.prisma.order.findFirstOrThrow();
    await expect(app.orders.markDispatched(seed.seller.id, order.id)).rejects.toThrow(/approved order not found/);
    await app.orders.decide(seed.seller.id, order.id, "approve");
    const other = await db.prisma.seller.create({ data: { slug: "other", name: "Other", accessKeyHash: "x" } });
    await expect(app.orders.markCardSent(other.id, order.id)).rejects.toThrow(/approved order not found/);
  });

  it("the public card is found by token, and gone after 'delete my photos'", async () => {
    const order = await approvedOrder();
    expect(await app.orders.cardByToken(order.cardToken!)).toMatchObject({ id: order.id });
    expect(await app.orders.cardByToken("not-a-real-token-at-all")).toBeNull();
    // the image is re-made on demand if it was lost
    await app.blobs.delete([order.cardImageKey!]);
    const key = await app.orders.ensureCardImage(order.id);
    expect(await app.blobs.get(key!)).not.toBeNull();

    await say("delete my photos");
    expect(await app.orders.cardByToken(order.cardToken!)).toBeNull();
    expect(await app.orders.ensureCardImage(order.id)).toBeNull();
  });

  it("retention clears numbers and card links on orders older than 30 days, even with sample photos", async () => {
    const sample = await addBuyerPhoto(db.prisma, app.blobs, null);
    await say("hi");
    await tap(BTN.agree);
    await tap(btn(BTN.sample, sample.id));
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await tap(BTN.order);
    await say("98765 43210");
    const order = await db.prisma.order.findFirstOrThrow();
    await app.orders.decide(seed.seller.id, order.id, "approve");

    expect((await app.consent.purgeExpired()).orders).toBe(0);
    clock = new Date(clock.getTime() + 31 * DAY);
    expect((await app.consent.purgeExpired()).orders).toBe(1);
    expect(await db.prisma.order.findFirstOrThrow()).toMatchObject({ buyerWhatsapp: null, cardToken: null, cardImageKey: null });
  });
});

describe("family vote", () => {
  it("'Ask family' makes one 7-day link to this preview, shareable on WhatsApp", async () => {
    await toPreview();
    const o = await tap(BTN.askFamily);
    expect(texts(o)).toMatch(/only this try-on image and the outfit name[\s\S]*You're choosing to share this image[\s\S]*7 days/);
    const vote = await db.prisma.familyVote.findFirstOrThrow();
    expect(vote.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(vote.expiresAt.getTime() - clock.getTime()).toBe(7 * DAY);
    expect(vote.garmentLabel).toBe("saree");

    const linkMsgs = o.filter((m) => m.kind === "link") as Array<{ label: string; href: string }>;
    expect(linkMsgs.map((l) => l.href)).toContain(`/v/${vote.token}`);
    const wa = linkMsgs.find((l) => l.href.startsWith("https://wa.me/?text="))!;
    expect(decodeURIComponent(wa.href.split("text=")[1])).toBe(`What do you think, should I buy this saree? Tap to vote: https://shop.example/v/${vote.token}`);
    // still in the preview, with "Order this" active and no second "Ask family"
    expect(await state()).toBe("PREVIEW");
    expect(buttonIds(o)).toEqual([BTN.order, BTN.tryAnother, BTN.newPhoto]);

    await tap(BTN.askFamily);
    expect(await db.prisma.familyVote.count()).toBe(1); // reused
  });

  it("votes reach the buyer's chat as a tally; one changeable vote per browser", async () => {
    await toPreview();
    await tap(BTN.askFamily);
    const { token } = await db.prisma.familyVote.findFirstOrThrow();

    expect(await app.family.cast(token, "browser-mum", true, "  Mum  ")).toEqual({ yes: 1, no: 0 });
    expect(await app.family.cast(token, "browser-x", false, "")).toEqual({ yes: 1, no: 1 });
    expect(await app.family.cast(token, "browser-x", true)).toEqual({ yes: 2, no: 0 }); // changed their vote
    await app.family.cast(token, "browser-mum", true, "Mum"); // same answer again: no new message

    const tallies = (await history()).filter((m) => m.kind === "text" && m.text.startsWith("Family vote"));
    expect(tallies.map((m) => (m as { text: string }).text)).toEqual([
      "Family vote on saree: 👍 1 yes · 👎 0 no. Mum said yes.",
      "Family vote on saree: 👍 1 yes · 👎 1 no. Someone said no.",
      "Family vote on saree: 👍 2 yes · 👎 0 no. Someone said yes.",
    ]);
    expect(await state()).toBe("PREVIEW");
    // a voter's browser id is never stored as-is
    const keys = (await db.prisma.familyVoteResponse.findMany()).map((r) => r.voterKey);
    expect(keys.some((k) => k.includes("browser"))).toBe(false);
  });

  it("names are cleaned and short", async () => {
    await toPreview();
    await tap(BTN.askFamily);
    const { token } = await db.prisma.familyVote.findFirstOrThrow();
    await app.family.cast(token, "b1", true, "<b>Priya</b>\n" + "x".repeat(80));
    const r = await db.prisma.familyVoteResponse.findFirstOrThrow();
    expect(r.name).not.toMatch(/[<>\n]/);
    expect(r.name!.length).toBeLessThanOrEqual(40);
  });

  it("links stop working after 7 days and are purged", async () => {
    await toPreview();
    await tap(BTN.askFamily);
    const { token } = await db.prisma.familyVote.findFirstOrThrow();
    expect(await app.family.findOpen(token)).not.toBeNull();
    clock = new Date(clock.getTime() + 7 * DAY + 1);
    expect(await app.family.findOpen(token)).toBeNull();
    await expect(app.family.cast(token, "b1", true)).rejects.toBeInstanceOf(VoteClosedError);
    expect(await app.family.purgeExpired()).toBe(1);
    expect(await db.prisma.familyVote.count()).toBe(0);
  });

  it("'delete my photos' deletes family links, also those made with a sample photo", async () => {
    await toPreview();
    await tap(BTN.askFamily);
    const own = await db.prisma.familyVote.findFirstOrThrow();
    await app.family.cast(own.token, "b1", true);

    // a second preview made with a sample photo (sample photos are never deleted)
    const sample = await addBuyerPhoto(db.prisma, app.blobs, null, "#aa3355");
    await tap(BTN.newPhoto);
    await tap(btn(BTN.sample, sample.id));
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await tap(BTN.askFamily);
    expect(await db.prisma.familyVote.count()).toBe(2);

    const o = await say("delete my photos");
    expect(texts(o)).toMatch(/Also deleted: 2 family vote links\./);
    expect(await db.prisma.familyVote.count()).toBe(0);
    expect(await db.prisma.familyVoteResponse.count()).toBe(0);
    expect(await app.family.findOpen(own.token)).toBeNull();
  });

  it("no family link for a blocked or missing preview", async () => {
    await say("hi");
    await consentAndPhoto();
    expect(texts(await tap(BTN.askFamily))).toMatch(/can't make a family link/);
    expect(await db.prisma.familyVote.count()).toBe(0);
  });
});
