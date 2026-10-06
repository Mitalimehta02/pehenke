import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app";
import type { Face } from "../look/faceFinder";
import { LIP_INTENSITY } from "../look/service";
import { buildOrderCard } from "../orders/cardData";
import { storeImage } from "../storage/blobs";
import { setupTestDb } from "../testing/db";
import { FakeYouCam } from "../testing/fakeYoucam";
import { addBuyerPhoto, personImage, seedBasics } from "../testing/fixtures";
import { BTN, btn, type ChatMessage, type Incoming, type Outgoing } from "./types";

/** "Complete the look": chat flow, pipeline, caps, order and card, deletion. Fake API, no units. */

const db = setupTestDb();
let fake: FakeYouCam;
let app: App;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let acc: { jhumka: { id: string }; stud: { id: string }; necklace: { id: string } };

const CAPS = { youcamDailyUnits: 60, buyerDailyRenders: 6, geminiDailyLimit: 18, buyerDailyLooks: 3 };
/** The head of the personImage fixture. */
const FACE: Face = { cx: 0.5, cy: 0.1, size: 0.22, score: 100 };
const newApp = (caps = CAPS, pollTimeoutMs?: number) => createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps, findFaces: async () => [FACE], pollTimeoutMs });

async function addAccessory(type: "earring" | "necklace", label: string, priceInr: number | null, color: string) {
  const img = await sharp({ create: { width: 500, height: 500, channels: 3, background: color } }).jpeg().toBuffer();
  const s = await storeImage(app.blobs, "accessory", img);
  return db.prisma.accessory.create({
    data: { sellerId: seed.seller.id, type, label, priceInr, photoKey: s.key, photoHash: s.hash, photoW: s.width, photoH: s.height, gateStatus: "approved", gateBy: "rules" },
  });
}

beforeEach(async () => {
  fake = new FakeYouCam();
  app = newApp();
  seed = await seedBasics(db.prisma, app.blobs);
  acc = {
    jhumka: await addAccessory("earring", "Gold jhumka", 450, "#c8961e"),
    stud: await addAccessory("earring", "Pearl stud", 250, "#e8e2d0"),
    necklace: await addAccessory("necklace", "Temple necklace", 1250, "#b0801a"),
  };
});
afterEach(async () => {
  await app.tryOns.idle();
  await app.looks.idle();
});

const base = (buyer = "cookie-1") => ({ channel: "web" as const, sellerSlug: "asha-sarees", buyerExternalId: buyer });
const out = (r: { messages: ChatMessage[] }) => r.messages.filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
const say = async (text: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "text", text }));
const tap = async (id: string, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "button", id }));
const send = async (bytes: Uint8Array, buyer?: string) => out(await app.engine.handle({ ...base(buyer), kind: "image", bytes } as Incoming));
const texts = (o: Outgoing[]) => o.map((m) => ("text" in m ? m.text : "caption" in m ? m.caption : "")).join("\n");
const buttonIds = (o: Outgoing[]) => o.flatMap((m) => ("buttons" in m && m.buttons ? m.buttons.map((b) => b.id) : []));
const choiceIds = (o: Outgoing[]) => o.flatMap((m) => (m.kind === "choices" ? m.choices.map((c) => c.id) : []));
const state = async (buyer = "cookie-1") => (await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } })).state;
const history = async (buyer = "cookie-1") => {
  const conv = await db.prisma.conversation.findFirstOrThrow({ where: { buyer: { externalId: buyer } } });
  return (await app.engine.messagesSince(conv.id)).filter((m) => m.direction === "out").map((m) => m.body as Outgoing);
};
const lookStarts = () => fake.starts.filter((s) => s.body.feature).map((s) => s.body.feature as string);
const settle = async () => {
  await app.tryOns.idle();
  await app.looks.idle();
};

async function toPreview(buyer?: string, torso?: string) {
  await say("hi", buyer);
  await tap(BTN.agree, buyer);
  const o = await send(await personImage(torso), buyer);
  await tap(buttonIds(o).find((id) => id.startsWith(`${BTN.yesFull}:`))!, buyer);
  await tap(btn(BTN.garment, seed.garment.id), buyer);
  await app.tryOns.idle();
  expect(await state(buyer)).toBe("PREVIEW");
}

/** Through the free choices to the summary: earrings, neck = bare, necklace, lip shade. */
async function pickAll(buyer?: string, lip = "0") {
  await tap(BTN.completeLook, buyer);
  await tap(btn(BTN.lookEarring, acc.jhumka.id), buyer);
  await tap(BTN.neckYes, buyer);
  await tap(btn(BTN.lookNecklace, acc.necklace.id), buyer);
  return tap(btn(BTN.lookLip, lip), buyer);
}

describe("choosing a look is free; rendering happens only on 'Show me'", () => {
  it("earrings -> neck question with the close-up -> necklace -> lip shades -> summary -> two images", async () => {
    await toPreview();
    expect(buttonIds(await history())).toContain(BTN.completeLook);

    const first = await tap(BTN.completeLook);
    expect(texts(first)).toMatch(/Choosing is free: nothing is made until you tap "Show me"/);
    expect(choiceIds(first)).toEqual([btn(BTN.lookEarring, acc.jhumka.id), btn(BTN.lookEarring, acc.stud.id)]);
    expect(texts(first)).not.toMatch(/covers your ears/);
    expect(buttonIds(first)).toEqual([btn(BTN.lookEarring, "none")]);
    expect(await state()).toBe("LOOK_PICK");

    const neck = await tap(btn(BTN.lookEarring, acc.jhumka.id));
    const q = neck.find((m) => m.kind === "image") as { mediaKey: string; caption: string };
    expect(q.caption).toMatch(/Is your neck bare in this picture\?/);
    expect(q.mediaKey).toMatch(/^look\//); // the close-up of their own preview
    expect(buttonIds(neck)).toEqual([BTN.neckYes, BTN.neckNo]);

    const necklaces = await tap(BTN.neckYes);
    expect(choiceIds(necklaces)).toEqual([btn(BTN.lookNecklace, acc.necklace.id)]);

    const lips = await tap(btn(BTN.lookNecklace, acc.necklace.id));
    expect(texts(lips)).toMatch(/styling suggestion only, we don't sell it/);
    const lipChoices = (lips.find((m) => m.kind === "choices") as { choices: Array<{ id: string; label: string; mediaKey: string }> }).choices;
    expect(lipChoices.map((c) => c.id)).toEqual([btn(BTN.lookLip, "0"), btn(BTN.lookLip, "1")]);
    expect(lipChoices.every((c) => c.mediaKey.startsWith("swatch/"))).toBe(true);

    const summary = await tap(btn(BTN.lookLip, "0"));
    expect(texts(summary)).toMatch(/Earrings: Gold jhumka · ₹450[\s\S]*Necklace: Temple necklace · ₹1,250[\s\S]*Lip colour: .* \(styling suggestion\)/);
    // honesty: jewellery is small in the full picture; the close-up is the better guide
    expect(texts(summary)).toMatch(/shown at small size[\s\S]*the close-up is the better guide/);
    expect(buttonIds(summary)).toEqual([BTN.lookShow, BTN.lookRestart, BTN.lookBack]);
    // nothing rendered or charged so far (one try-on start only)
    expect(fake.starts).toHaveLength(1);
    expect(await db.prisma.look.count()).toBe(0);

    const working = await tap(BTN.lookShow);
    expect(working[0]).toEqual({ kind: "status", status: "working" });
    expect(await state()).toBe("LOOK_RUNNING");
    expect(texts(await say("hello?"))).toMatch(/Still working on your look/);
    await settle();

    const images = (await history()).filter((m) => m.kind === "image").slice(-2) as Array<{ mediaKey: string; caption: string; buttons?: unknown }>;
    const look = await db.prisma.look.findFirstOrThrow();
    expect(images.map((i) => i.mediaKey)).toEqual([look.outputKey, look.closeupKey]);
    expect(images[1].caption).toMatch(/use this close-up as the better guide[\s\S]*lip colour is a styling suggestion, not part of your order/);
    expect(buttonIds(await history()).slice(-4)).toEqual([BTN.orderLook, BTN.order, BTN.completeLook, BTN.tryAnother]);
    expect(await state()).toBe("PREVIEW");
  });

  it("pipeline: necklace -> earrings -> lipstick on the crop, 1 unit each, logged per step; no nulls; smoothing 0", async () => {
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();

    expect(lookStarts()).toEqual(["2d-vto/necklace", "2d-vto/earring", "makeup-vto"]);
    const [n, e, m] = fake.starts.slice(1).map((s) => s.body as Record<string, unknown>);
    for (const jewellery of [n, e]) {
      const params = (jewellery.object_infos as Array<{ parameter: Record<string, unknown> }>)[0].parameter;
      expect(Object.values(params)).not.toContain(null);
      expect(Object.keys(params).some((k) => /anchor_point|wearing_location|scale/.test(k))).toBe(false);
    }
    const effects = m.effects as Array<Record<string, unknown>>;
    expect(effects[0]).toEqual({ category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 });
    expect(effects[1]).toMatchObject({ category: "lip_color", shape: { name: "original" }, palettes: [{ texture: "matte", colorIntensity: LIP_INTENSITY }] });

    const look = await db.prisma.look.findFirstOrThrow();
    expect(look).toMatchObject({ status: "succeeded", units: 3, necklaceId: acc.necklace.id, earringId: acc.jhumka.id });
    const steps = await db.prisma.lookStep.findMany({ orderBy: { createdAt: "asc" } });
    expect(steps.map((s) => [s.feature, s.status, s.units, !!s.taskId])).toEqual([
      ["2d-vto/necklace", "succeeded", 1, true],
      ["2d-vto/earring", "succeeded", 1, true],
      ["makeup-vto", "succeeded", 1, true],
    ]);
    // the ledger has the try-on (2) plus one unit per look step, each against its own task
    expect(await app.ledger.youcamUnitsToday()).toBe(5);
    const charged = await db.prisma.apiCall.findMany({ where: { units: { gt: 0 } }, orderBy: { createdAt: "asc" } });
    expect(charged.map((c) => [c.endpoint, c.units])).toEqual([
      ["GET /s2s/v2.0/task/cloth-v3/:id", 2],
      ["GET /s2s/v2.0/task/2d-vto/necklace/:id", 1],
      ["GET /s2s/v2.0/task/2d-vto/earring/:id", 1],
      ["GET /s2s/v2.0/task/makeup-vto/:id", 1],
    ]);
    expect(new Set(charged.map((c) => c.taskId)).size).toBe(4);

    // the full-body look differs from the try-on only around the head; the rest is the same picture
    const tryOn = await db.prisma.tryOn.findFirstOrThrow();
    const a = await sharp((await app.blobs.get(tryOn.outputKey!))!.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp((await app.blobs.get(look.outputKey!))!.bytes).removeAlpha().raw().toBuffer();
    const w = a.info.width;
    let below = 0, head = 0;
    for (let i = 0; i < a.data.length; i += 3) {
      const y = (i / 3 / w) | 0;
      const d = Math.max(Math.abs(a.data[i] - b[i]), Math.abs(a.data[i + 1] - b[i + 1]), Math.abs(a.data[i + 2] - b[i + 2]));
      if (d > 40 && y > 600) below++;
      else if (d > 40) head++;
    }
    expect(head).toBeGreaterThan(300);
    expect(below).toBe(0);
  });

  it("caches: the same look is free; changing only the lip shade costs one step", async () => {
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    expect(lookStarts()).toHaveLength(3);

    // same choices again: shown straight away, nothing new
    await pickAll();
    const again = await tap(BTN.lookShow);
    expect(again.filter((m) => m.kind === "image")).toHaveLength(2);
    expect(lookStarts()).toHaveLength(3);
    expect(await db.prisma.look.count()).toBe(1);

    // other lip shade: jewellery steps are reused
    await pickAll(undefined, "1");
    await tap(BTN.lookShow);
    await settle();
    expect(lookStarts()).toEqual(["2d-vto/necklace", "2d-vto/earring", "makeup-vto", "makeup-vto"]);
    expect((await db.prisma.look.findMany({ orderBy: { createdAt: "asc" } })).map((l) => l.units)).toEqual([3, 1]);
  });

  it("'No' to the neck question: no necklace is offered, and the chat says why", async () => {
    await toPreview();
    await tap(BTN.completeLook);
    await tap(btn(BTN.lookEarring, "none"));
    const o = await tap(BTN.neckNo);
    expect(texts(o)).toMatch(/I won't add a necklace\. Any jewellery already in the preview is illustrative and not included/);
    expect(choiceIds(o).every((id) => id.startsWith(BTN.lookLip))).toBe(true);
    await tap(btn(BTN.lookLip, "0"));
    await tap(BTN.lookShow);
    await settle();
    expect(lookStarts()).toEqual(["makeup-vto"]);
    // the answer is stored with the order, for the seller
    await tap(BTN.orderLook);
    await tap(BTN.skipPhone);
    expect(await db.prisma.order.findFirstOrThrow()).toMatchObject({ lookNeckBare: false });
  });

  it("ears covered in the preview: says so in plain words instead of hiding the option", async () => {
    await toPreview();
    const tryOn = await db.prisma.tryOn.findFirstOrThrow();
    await app.looks.prepare(tryOn.id);
    const prep = (await db.prisma.tryOn.findFirstOrThrow()).lookPrep as Record<string, unknown>;
    expect(prep).toMatchObject({ earsClear: true });
    await db.prisma.tryOn.update({ where: { id: tryOn.id }, data: { lookPrep: { ...prep, earsClear: false } } });

    const o = await tap(BTN.completeLook);
    expect(texts(o)).toMatch(/The outfit covers your ears in this picture .* so I can't add earrings/);
    expect(choiceIds(o).some((id) => id.startsWith(BTN.lookEarring))).toBe(false);
    expect(buttonIds(o)).toEqual([BTN.neckYes, BTN.neckNo]); // goes on to the necklace
    // and the service refuses earrings on this render even if asked directly
    expect(await app.looks.request({ tryOnId: tryOn.id, buyerId: null, earringId: acc.jhumka.id })).toEqual({ kind: "refused", reason: "ears_covered" });
  });

  it("no face found: the look isn't offered, the preview stays", async () => {
    app = createApp({ prisma: db.prisma, youcam: (l) => fake.client(l), caps: CAPS, findFaces: async () => [] });
    await toPreview();
    const o = await tap(BTN.completeLook);
    expect(texts(o)).toMatch(/couldn't find your face clearly enough/);
    expect(await state()).toBe("PREVIEW");
    expect(buttonIds(o)).not.toContain(BTN.completeLook);
  });

  it("nothing chosen, or 'Back': returns to the preview without rendering", async () => {
    await toPreview();
    await tap(BTN.completeLook);
    await tap(btn(BTN.lookEarring, "none"));
    await tap(BTN.neckNo);
    const o = await tap(btn(BTN.lookLip, "none"));
    expect(texts(o)).toMatch(/Nothing chosen/);
    expect(await state()).toBe("PREVIEW");
    await pickAll();
    expect(texts(await tap(BTN.lookBack))).toMatch(/back to your preview/);
    expect(await state()).toBe("PREVIEW");
    expect(lookStarts()).toEqual([]);
  });

  it("hidden or rejected jewellery is never offered", async () => {
    await db.prisma.accessory.update({ where: { id: acc.stud.id }, data: { active: false } });
    await db.prisma.accessory.update({ where: { id: acc.necklace.id }, data: { gateStatus: "rejected" } });
    await toPreview();
    const o = await tap(BTN.completeLook);
    expect(choiceIds(o)).toEqual([btn(BTN.lookEarring, acc.jhumka.id)]);
    const next = await tap(btn(BTN.lookEarring, "none"));
    expect(texts(next)).not.toMatch(/neck bare/); // no necklace to offer, so no question
  });
});

describe("caps and failures", () => {
  it("per buyer: 3 new looks a day by default here 1; cached looks stay free", async () => {
    app = newApp({ ...CAPS, buyerDailyLooks: 1 });
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();

    await tap(BTN.completeLook);
    await tap(btn(BTN.lookEarring, acc.stud.id));
    await tap(BTN.neckNo);
    await tap(btn(BTN.lookLip, "none"));
    const refused = await tap(BTN.lookShow);
    expect(texts(refused)).toMatch(/You've made 1 new looks today, which is the daily limit\. Looks you've already seen are still available/);
    expect(await state()).toBe("PREVIEW");
    expect(lookStarts()).toHaveLength(3);

    // the look they already made is cached: still shown
    await pickAll();
    expect((await tap(BTN.lookShow)).filter((m) => m.kind === "image")).toHaveLength(2);
    // another buyer is not affected
    await toPreview("cookie-2", "#22aa55");
    await tap(BTN.completeLook, "cookie-2");
    await tap(btn(BTN.lookEarring, acc.stud.id), "cookie-2");
    await tap(BTN.neckNo, "cookie-2");
    await tap(btn(BTN.lookLip, "none"), "cookie-2");
    expect((await tap(BTN.lookShow, "cookie-2"))[0]).toEqual({ kind: "status", status: "working" });
  });

  it("looks count toward the app's daily unit cap", async () => {
    // try-on 2 units + room for only 2 more: a 3-step look doesn't fit, a 1-step look does
    app = newApp({ ...CAPS, youcamDailyUnits: 4 });
    await toPreview();
    await pickAll();
    expect(texts(await tap(BTN.lookShow))).toMatch(/Looks are paused for today because we've reached our daily limit/);
    expect(lookStarts()).toEqual([]);
    await tap(BTN.completeLook);
    await tap(btn(BTN.lookEarring, "none"));
    await tap(BTN.neckNo);
    await tap(btn(BTN.lookLip, "0"));
    await tap(BTN.lookShow);
    await settle();
    expect(lookStarts()).toEqual(["makeup-vto"]);
    expect(await app.ledger.youcamUnitsToday()).toBe(3);
  });

  it("a failed step costs nothing; the earlier paid step is kept for the next attempt", async () => {
    fake.opts.failFeatures = ["2d-vto/earring"];
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    const last = (await history()).slice(-1);
    expect(texts(last)).toMatch(/couldn't make that look\. Nothing was charged to you/);
    expect(await state()).toBe("PREVIEW");
    expect(await db.prisma.look.findFirstOrThrow()).toMatchObject({ status: "failed", units: 1 });
    expect(await app.ledger.youcamUnitsToday()).toBe(3); // try-on 2 + necklace 1; the failed earring 0

    fake.opts.failFeatures = [];
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    // necklace reused, earring and lipstick new
    expect(lookStarts()).toEqual(["2d-vto/necklace", "2d-vto/earring", "2d-vto/earring", "makeup-vto"]);
    expect(await db.prisma.look.findFirstOrThrow()).toMatchObject({ status: "succeeded", units: 2 });
  });

  it("a look interrupted mid-step resumes by polling the saved task, never starting it twice", async () => {
    await toPreview();
    app = newApp(CAPS, 1); // gives up polling almost at once, like a process that died
    fake.opts.runningPolls = 1_000_000;
    await tap(BTN.completeLook);
    await tap(btn(BTN.lookEarring, "none"));
    await tap(BTN.neckNo);
    await tap(btn(BTN.lookLip, "0"));
    await tap(BTN.lookShow);
    await app.looks.idle();
    expect(await db.prisma.lookStep.findFirstOrThrow()).toMatchObject({ status: "running", taskId: expect.any(String) });
    expect(await state()).toBe("LOOK_RUNNING");

    // new process
    fake.opts.runningPolls = 0;
    app = newApp();
    expect(await app.looks.resumeAll()).toBe(1);
    await settle();
    expect(lookStarts()).toEqual(["makeup-vto"]);
    expect(await db.prisma.look.findFirstOrThrow()).toMatchObject({ status: "succeeded", units: 1 });
    expect(await state()).toBe("PREVIEW");
  });
});

describe("order and card", () => {
  async function orderedLook() {
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    await tap(BTN.orderLook);
    await tap(BTN.skipPhone);
    return db.prisma.order.findFirstOrThrow({ include: { items: true, garment: true, seller: true, tryOn: true, look: true } });
  }

  it("'Order this look' adds the jewellery; the card lists Ordered items with a total and the lip shade as styling", async () => {
    const order = await orderedLook();
    expect(order.lookId).not.toBeNull();
    expect(order.lookNeckBare).toBe(true);
    expect(order.items.map((i) => [i.type, i.label, i.priceInr])).toEqual([
      ["earring", "Gold jhumka", 450],
      ["necklace", "Temple necklace", 1250],
    ]);
    const card = buildOrderCard(order);
    expect(card.imageKey).toBe(order.look!.outputKey);
    expect(card.closeupKey).toBe(order.look!.closeupKey);
    expect(card.totalInr).toBe(1899 + 450 + 1250);
    expect(card.lines).toEqual([
      "Ordered:",
      "• saree · ₹1,899",
      "• Earrings: Gold jhumka · ₹450",
      "• Necklace: Temple necklace · ₹1,250",
      "Total ₹3,599",
      expect.stringMatching(/^Order #\w{6} · Asha Sarees$/),
      expect.stringMatching(/^Styling suggestion, not included: lip colour \(.+\)$/),
      "Saree as ordered. Styling, accessories and other garments shown are illustrative.",
    ]);

    // seller approval is unchanged: nothing reaches the buyer before it
    expect(order.cardStatus).toBe("pending_seller");
    await app.orders.decide(seed.seller.id, order.id, "approve");
    const sent = (await history()).find((m) => m.kind === "card") as { mediaKey: string; lines: string[] };
    expect(sent.mediaKey).toBe(order.look!.outputKey);
    expect(sent.lines).toContain("Total ₹3,599");
    // the shareable card image is drawn from the look
    const approved = await db.prisma.order.findFirstOrThrow();
    expect((await sharp((await app.blobs.get(approved.cardImageKey!))!.bytes).metadata()).width).toBe(1080);
  });

  it("'Order outfit only' after a look: plain try-on card, no jewellery, no styling line", async () => {
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    await tap(BTN.order);
    await tap(BTN.skipPhone);
    const order = await db.prisma.order.findFirstOrThrow({ include: { items: true, garment: true, seller: true, tryOn: true, look: true } });
    expect(order).toMatchObject({ lookId: null, lookItems: null, lookNeckBare: null });
    expect(order.items).toEqual([]);
    const card = buildOrderCard(order);
    expect(card.imageKey).toBe(order.tryOn!.outputKey);
    expect(card.lines.join(" ")).not.toMatch(/Ordered:|Total|Styling suggestion/);
  });

  it("no total when an ordered item has no price", () => {
    const card = buildOrderCard({
      id: "cmabc123hnxzf6",
      disclosureText: null,
      garment: { label: "Kurti", priceInr: 899 },
      seller: { name: "Asha" },
      tryOn: { outputKey: "tryon/a.jpg" },
      look: { outputKey: "look/b.jpg", closeupKey: "look/c.jpg" },
      lookItems: [{ kind: "earring", label: "Jhumka", priceInr: null, ordered: true, fromSellerPhoto: true }],
    });
    expect(card.totalInr).toBeNull();
    expect(card.lines).toEqual(["Ordered:", "• Kurti · ₹899", "• Earrings: Jhumka", "Order #HNXZF6 · Asha"]);
  });
});

describe("deletion", () => {
  it("'delete my photos' deletes looks, close-ups, step images and look choices, here and at YouCam", async () => {
    await toPreview();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    await tap(BTN.orderLook);
    await tap(BTN.skipPhone);
    const look = await db.prisma.look.findFirstOrThrow();
    const tryOn = await db.prisma.tryOn.findFirstOrThrow();
    const steps = await db.prisma.lookStep.findMany();
    const keys = [look.outputKey!, look.closeupKey!, tryOn.closeupKey!, ...steps.map((s) => s.outputKey!)];
    for (const k of keys) expect(await app.blobs.get(k)).not.toBeNull();

    const o = await say("delete my photos");
    expect(texts(o)).toMatch(/1 photo and 1 try-on image \(with 1 completed look\)/);
    expect(await db.prisma.look.count()).toBe(0);
    expect(await db.prisma.lookStep.count()).toBe(0);
    for (const k of keys) expect(await app.blobs.get(k)).toBeNull();
    // the crops of the buyer's face that went to the look features are deleted at YouCam too
    for (const s of steps) expect(fake.deletes).toContain(s.taskId);

    // the order keeps what was ordered (the seller's record); the look, the styling and the neck answer are gone
    const order = await db.prisma.order.findFirstOrThrow({ include: { items: true } });
    expect(order).toMatchObject({ lookId: null, lookNeckBare: null, tryOnId: null });
    expect((order.lookItems as Array<{ kind: string }>).map((i) => i.kind)).toEqual(["earring", "necklace"]);
    expect(order.items).toHaveLength(2);
    // look images in the chat history are replaced
    const hist = JSON.stringify(await history());
    for (const k of keys) expect(hist).not.toContain(k);
    // choices in progress are gone with the conversation context
    expect((await db.prisma.conversation.findFirstOrThrow()).context).toEqual({});
    // the seller's jewellery is not the buyer's data
    expect(await db.prisma.accessory.count()).toBe(3);
  });

  it("looks made with a sample photo are not the buyer's photos and stay cached", async () => {
    const sample = await addBuyerPhoto(db.prisma, app.blobs, null, "#aa3355");
    await say("hi");
    await tap(BTN.agree);
    await tap(btn(BTN.sample, sample.id));
    await tap(btn(BTN.garment, seed.garment.id));
    await app.tryOns.idle();
    await pickAll();
    await tap(BTN.lookShow);
    await settle();
    await say("delete my photos");
    expect(await db.prisma.look.count()).toBe(1);
    expect(await app.blobs.get((await db.prisma.look.findFirstOrThrow()).outputKey!)).not.toBeNull();
  });
});
