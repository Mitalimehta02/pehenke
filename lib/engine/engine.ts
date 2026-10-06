import type { ConsentService } from "../consent/service";
import type { FamilyVoteService, VoteEvent } from "../family/service";
import type { Accessory, Conversation, ConvState, Garment, Prisma, PrismaClient, Seller } from "../generated/prisma/client";
import { links, waLink } from "../links";
import { lipShadesForGarment } from "../look/lipShade";
import { accessoryTryable, type LookPrep, type LookService, type SkippedItem } from "../look/service";
import { normalizePhone } from "../orders/phone";
import { checkBuyerPhoto } from "../photos/buyerPhoto";
import type { BlobStore } from "../storage/blobs";
import { storeImage } from "../storage/blobs";
import { buildOrderCard, type LookItem } from "../orders/cardData";
import type { TryOnService } from "../tryon/service";
import { DEFAULT_BUYER_DAILY_LOOKS } from "../units/ledger";
import sharp from "sharp";
import { copy } from "./copy";
import { BTN, btn, param, type Button, type ChatMessage, type Incoming, type Outgoing } from "./types";

/**
 * Conversation engine: handle(incoming) -> outgoing messages. A plain state
 * machine (no LLM); one handler per ConvState, global commands first.
 * Asynchronous results (finished renders, seller decisions, family votes)
 * arrive through onTryOnFinished / onOrderDecided / onFamilyVote and are
 * appended to the same conversation; adapters deliver every stored outgoing
 * message.
 *
 *   NEW -> AWAIT_CONSENT -> AWAIT_PHOTO -> PICK_GARMENT -> TRYON_RUNNING -> PREVIEW
 *       -> AWAIT_PHONE -> AWAIT_SELLER -> ORDERED            (DECLINED: consent refused)
 *   PREVIEW: "Ask family" makes a public vote link and stays in PREVIEW.
 *   PREVIEW -> LOOK_PICK (earrings, neck question, necklace, lip shade: all free)
 *           -> LOOK_RUNNING -> PREVIEW (now showing the look)
 *   any state: "delete my photos" | "stop" | "help"
 */

export interface EngineDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  consent: ConsentService;
  /** public base URL, for links the buyer shares outside the chat */
  baseUrl: string;
  /** set after construction (the try-on service calls back into the engine) */
  tryOns?: TryOnService;
  family?: FamilyVoteService;
  looks?: LookService;
}

/** "Complete the look" choices being made. undefined = not asked yet, null = none wanted / not possible. */
interface LookDraft {
  tryOnId: string;
  /** the two shades proposed for this garment */
  lips: Array<{ hex: string; name: string; swatchKey: string }>;
  earringId?: string | null;
  /** answer to "Is your neck bare in this picture?" */
  neckBare?: boolean | null;
  necklaceId?: string | null;
  lip?: { hex: string; name: string } | null;
}

interface Ctx {
  /** accepted person photo (buyer's or a sample) */
  photoId?: string;
  /** uploaded, waiting for "head to toe" confirmation */
  pendingPhotoId?: string;
  garmentId?: string;
  /** render shown in the current preview */
  previewTryOnId?: string;
  orderId?: string;
  /** outfit preselected by a shared link: rendered as soon as there's a photo */
  wantGarmentId?: string;
  look?: LookDraft;
  /** look being made (LOOK_RUNNING) */
  pendingLookId?: string;
  /** look shown in the current preview, and the buyer's neck answer for it */
  lookId?: string;
  lookNeckBare?: boolean | null;
  /** "Order this look": the look and its jewellery go on the order */
  orderLook?: boolean;
  /** jewellery that could not be placed on this preview (may be ordered without a picture) */
  lookSkipped?: string[];
  /** of those, the ones the buyer added to the order: listed on the card as "not shown" */
  addUnshown?: string[];
}

interface Turn {
  conv: Conversation;
  seller: Seller;
  ctx: Ctx;
  state: ConvState;
  activeTryOnId: string | null;
  out: Outgoing[];
}

export class NotFoundError extends Error {}

export class Engine {
  tryOns?: TryOnService;
  family?: FamilyVoteService;
  looks?: LookService;
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: EngineDeps) {
    this.tryOns = d.tryOns;
    this.family = d.family;
    this.looks = d.looks;
  }

  // ---------------- entry points ----------------

  async handle(inc: Incoming): Promise<{ conversationId: string; messages: ChatMessage[] }> {
    const { prisma } = this.d;
    const seller = await prisma.seller.findUnique({ where: { slug: inc.sellerSlug } });
    if (!seller) throw new NotFoundError(`no seller ${inc.sellerSlug}`);
    const buyer = await prisma.buyer.upsert({
      where: { channel_externalId: { channel: inc.channel, externalId: inc.buyerExternalId } },
      create: { channel: inc.channel, externalId: inc.buyerExternalId },
      update: {},
    });
    const conv = await prisma.conversation.upsert({
      where: { sellerId_buyerId_channel: { sellerId: seller.id, buyerId: buyer.id, channel: inc.channel } },
      create: { sellerId: seller.id, buyerId: buyer.id, channel: inc.channel },
      update: {},
    });
    return this.withLock(conv.id, async () => {
      const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      const turn = this.turn(fresh, seller);
      if (inc.kind === "open") {
        const want = inc.garmentId ? await this.tryableGarment(seller.id, inc.garmentId) : null;
        if (turn.state === "NEW") await this.greet(turn, want);
        else if (want) await this.offerGarment(turn, want);
        return { conversationId: conv.id, messages: await this.commit(turn) };
      }
      const incoming = await this.recordIncoming(turn, inc);
      await this.dispatch(turn, inc);
      const outgoing = await this.commit(turn);
      return { conversationId: conv.id, messages: [...incoming, ...outgoing] };
    });
  }

  /** A render finished: answer every conversation waiting for it. */
  async onTryOnFinished(tryOnId: string): Promise<void> {
    const convs = await this.d.prisma.conversation.findMany({ where: { activeTryOnId: tryOnId }, include: { seller: true } });
    for (const c of convs) {
      await this.withLock(c.id, async () => {
        const fresh = await this.d.prisma.conversation.findUniqueOrThrow({ where: { id: c.id } });
        if (fresh.state !== "TRYON_RUNNING" || fresh.activeTryOnId !== tryOnId) return;
        const turn = this.turn(fresh, c.seller);
        await this.showResult(turn, tryOnId);
        await this.commit(turn);
      });
    }
  }

  /** The seller approved or rejected an order card. */
  async onOrderDecided(orderId: string): Promise<void> {
    const { prisma } = this.d;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { garment: true, tryOn: true, seller: true, look: true } });
    await this.withLock(order.conversationId, async () => {
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: order.conversationId } });
      const turn = this.turn(conv, order.seller);
      if (order.cardStatus === "approved") {
        const card = buildOrderCard(order);
        turn.out.push({ kind: "text", text: copy.orderApproved() });
        turn.out.push({ kind: "card", mediaKey: card.imageKey, title: card.title, lines: card.lines, buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)] });
        if (order.cardToken) turn.out.push({ kind: "link", label: copy.cardLink(), href: links.card("", order.cardToken) });
        if (turn.state === "AWAIT_SELLER") turn.state = "ORDERED";
      } else if (order.cardStatus === "rejected") {
        turn.out.push({ kind: "text", text: copy.orderRejected(order.sellerNote), buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)] });
        if (turn.state === "AWAIT_SELLER") turn.state = "PICK_GARMENT";
      }
      await this.commit(turn);
    });
  }

  /** A look finished (or failed): answer every conversation waiting for it. */
  async onLookFinished(lookId: string): Promise<void> {
    const convs = await this.d.prisma.conversation.findMany({
      where: { state: "LOOK_RUNNING", context: { path: ["pendingLookId"], equals: lookId } },
      include: { seller: true },
    });
    for (const c of convs) {
      await this.withLock(c.id, async () => {
        const fresh = await this.d.prisma.conversation.findUniqueOrThrow({ where: { id: c.id } });
        const turn = this.turn(fresh, c.seller);
        if (fresh.state !== "LOOK_RUNNING" || turn.ctx.pendingLookId !== lookId) return;
        await this.showLook(turn, lookId);
        await this.commit(turn);
      });
    }
  }

  /** Someone voted on a family link: post the tally in the buyer's chat (state unchanged). */
  async onFamilyVote(e: VoteEvent): Promise<void> {
    const { prisma } = this.d;
    await this.withLock(e.conversationId, async () => {
      const conv = await prisma.conversation.findUnique({ where: { id: e.conversationId }, include: { seller: true } });
      if (!conv) return;
      const turn = this.turn(conv, conv.seller);
      turn.out.push({ kind: "text", text: copy.familyTally(e.garmentLabel, e.tally, e.latest) });
      await this.commit(turn);
    });
  }

  /** The conversation for a buyer on a channel with a seller, if any. */
  async findConversation(sellerSlug: string, channel: "web" | "whatsapp", externalId: string) {
    return this.d.prisma.conversation.findFirst({
      where: { seller: { slug: sellerSlug }, channel, buyer: { channel, externalId } },
      select: { id: true, state: true },
    });
  }

  /** Messages of a conversation after a given message id (adapters poll this). */
  async messagesSince(conversationId: string, afterId?: string): Promise<ChatMessage[]> {
    const { prisma } = this.d;
    const after = afterId ? await prisma.message.findUnique({ where: { id: afterId } }) : null;
    const rows = await prisma.message.findMany({
      where: { conversationId, ...(after ? { createdAt: { gte: after.createdAt }, NOT: { id: after.id } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.filter((r) => !after || r.createdAt > after.createdAt || r.id > after.id).map(toChat);
  }

  // ---------------- dispatch ----------------

  private async dispatch(t: Turn, inc: Incoming) {
    const text = inc.kind === "text" ? inc.text.trim().toLowerCase() : "";
    const button = inc.kind === "button" ? inc.id : "";

    // Global commands, in any state.
    if (button === BTN.deletePhotos || /^(delete|remove)( all)?( my)? (photos?|pictures?|pics?|images?)$/.test(text)) {
      return this.deletePhotos(t);
    }
    if (/^(stop|withdraw( consent)?|unsubscribe)$/.test(text)) return this.revoke(t);
    if (text === "help") return void t.out.push({ kind: "text", text: copy.help() });

    switch (t.state) {
      case "NEW":
      case "DECLINED":
        if (t.state === "DECLINED" && !/^(hi|hello|hey|start|yes|ok|okay)\b/.test(text) && !button) {
          return void t.out.push({ kind: "text", text: copy.declined() });
        }
        return this.greet(t);
      case "AWAIT_CONSENT":
        return this.onConsent(t, inc, text, button);
      case "AWAIT_PHOTO":
        return this.onPhoto(t, inc, button);
      case "AWAIT_PHONE":
        return this.onPhone(t, inc, button);
      case "LOOK_PICK":
        return this.onLookPick(t, button);
      case "LOOK_RUNNING":
        return this.onLookRunning(t);
      case "PICK_GARMENT":
      case "PREVIEW":
      case "ORDERED":
      case "AWAIT_SELLER":
        return this.onBrowse(t, text, button);
      case "TRYON_RUNNING":
        return this.onRunning(t);
    }
  }

  private async greet(t: Turn, want?: Garment | null) {
    t.out.push({ kind: "text", text: copy.greeting(t.seller.name) });
    if (want) {
      t.ctx.wantGarmentId = want.id;
      t.out.push({ kind: "image", mediaKey: want.photoKey, caption: copy.wantGarment(want.label, want.priceInr) });
    }
    if (await this.d.consent.hasConsent(t.conv.buyerId)) return this.askPhoto(t);
    t.out.push({ kind: "text", text: copy.consent(), buttons: [this.b(BTN.agree, copy.buttons.agree), this.b(BTN.decline, copy.buttons.decline)] });
    t.state = "AWAIT_CONSENT";
  }

  private async onConsent(t: Turn, inc: Incoming, text: string, button: string) {
    if (button === BTN.agree || /^(yes|i agree|agree|ok|okay|haan|ha)$/.test(text)) {
      await this.d.consent.grant(t.conv.buyerId);
      return this.askPhoto(t);
    }
    if (button === BTN.decline || /^(no|no thanks|nahi)$/.test(text)) {
      t.out.push({ kind: "text", text: copy.declined() });
      t.state = "DECLINED";
      return;
    }
    // A photo before consent is not stored.
    t.out.push({ kind: "text", text: copy.consentReminder(), buttons: [this.b(BTN.agree, copy.buttons.agree), this.b(BTN.decline, copy.buttons.decline)] });
  }

  private async askPhoto(t: Turn) {
    const samples = await this.d.prisma.buyerPhoto.findMany({ where: { isSample: true }, orderBy: { createdAt: "asc" } });
    t.out.push(
      samples.length
        ? { kind: "choices", text: copy.askPhoto(true), choices: samples.map((s) => ({ id: btn(BTN.sample, s.id), label: s.sampleName ?? "Sample", mediaKey: s.blobKey })) }
        : { kind: "text", text: copy.askPhoto(false) },
    );
    t.state = "AWAIT_PHOTO";
  }

  private async onPhoto(t: Turn, inc: Incoming, button: string) {
    const { prisma, blobs } = this.d;
    if (inc.kind === "image") {
      const check = await checkBuyerPhoto(inc.bytes);
      if (!check.ok) return void t.out.push({ kind: "text", text: copy.photoRejected(check.reason) });
      const stored = await storeImage(blobs, "buyer", inc.bytes);
      const photo = await prisma.buyerPhoto.create({
        data: {
          buyerId: t.conv.buyerId,
          sellerId: t.seller.id,
          blobKey: stored.key,
          hash: stored.hash,
          width: stored.width,
          height: stored.height,
          framing: "unknown",
          accepted: false,
        },
      });
      t.ctx.pendingPhotoId = photo.id;
      t.out.push({ kind: "text", text: copy.confirmFullBody(), buttons: [this.b(btn(BTN.yesFull, photo.id), copy.buttons.yesFull), this.b(BTN.retake, copy.buttons.retake)] });
      return;
    }
    if (button.startsWith(`${BTN.yesFull}:`)) {
      const id = param(button);
      const photo = await prisma.buyerPhoto.findFirst({ where: { id, buyerId: t.conv.buyerId } });
      if (!photo) return this.askPhoto(t);
      await prisma.buyerPhoto.update({ where: { id }, data: { framing: "full", accepted: true } });
      t.ctx.photoId = id;
      t.ctx.pendingPhotoId = undefined;
      return this.afterPhoto(t);
    }
    if (button === BTN.retake) {
      if (t.ctx.pendingPhotoId) {
        await prisma.buyerPhoto.update({ where: { id: t.ctx.pendingPhotoId }, data: { framing: "chest", accepted: false, rejectReason: "buyer said not full body" } });
      }
      t.ctx.pendingPhotoId = undefined;
      return void t.out.push({ kind: "text", text: copy.retake() });
    }
    if (button.startsWith(`${BTN.sample}:`)) {
      const sample = await prisma.buyerPhoto.findFirst({ where: { id: param(button), isSample: true } });
      if (!sample) return this.askPhoto(t);
      t.ctx.photoId = sample.id;
      return this.afterPhoto(t);
    }
    t.out.push({ kind: "text", text: copy.photoReminder() });
  }

  /** A photo is ready: render the outfit the buyer came for, or list the outfits. */
  private async afterPhoto(t: Turn) {
    const want = t.ctx.wantGarmentId ? await this.tryableGarment(t.seller.id, t.ctx.wantGarmentId) : null;
    t.ctx.wantGarmentId = undefined;
    if (!want) return this.listGarments(t);
    t.state = "PICK_GARMENT";
    return this.startTryOn(t, want.id);
  }

  /**
   * Chat reopened from a shared outfit link. Opening a link never starts a
   * render by itself: before a photo it's remembered, after one it's offered.
   */
  private async offerGarment(t: Turn, g: Garment) {
    if (t.ctx.wantGarmentId === g.id) return; // same link reopened
    switch (t.state) {
      case "AWAIT_CONSENT":
      case "AWAIT_PHOTO":
        t.ctx.wantGarmentId = g.id;
        t.out.push({ kind: "image", mediaKey: g.photoKey, caption: copy.wantGarment(g.label, g.priceInr) });
        return;
      case "PICK_GARMENT":
      case "PREVIEW":
      case "AWAIT_PHONE":
      case "AWAIT_SELLER":
      case "ORDERED":
        if (!t.ctx.photoId) return;
        t.ctx.wantGarmentId = g.id;
        t.out.push({
          kind: "choices",
          text: copy.offerGarment(g.label),
          choices: [{ id: btn(BTN.garment, g.id), label: copy.garmentChoice(g.label, g.priceInr), mediaKey: g.photoKey }],
          buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)],
        });
        if (t.state === "AWAIT_PHONE") t.state = "PICK_GARMENT";
        return;
      default:
        return; // render running, or declined: nothing to add
    }
  }

  private async tryableGarment(sellerId: string, id: string) {
    return this.d.prisma.garment.findFirst({
      where: { id, sellerId, active: true, OR: [{ gateStatus: "approved" }, { gateStatus: "needs_review", sellerConfirmed: true }] },
    });
  }

  private async listGarments(t: Turn) {
    const garments = await this.d.prisma.garment.findMany({
      where: { sellerId: t.seller.id, active: true, OR: [{ gateStatus: "approved" }, { gateStatus: "needs_review", sellerConfirmed: true }] },
      orderBy: { createdAt: "asc" },
    });
    t.out.push({
      kind: "choices",
      text: copy.pickGarment(garments.length),
      choices: garments.map((g) => ({ id: btn(BTN.garment, g.id), label: copy.garmentChoice(g.label, g.priceInr), mediaKey: g.photoKey })),
      buttons: [this.b(BTN.newPhoto, copy.buttons.newPhoto)],
    });
    t.state = "PICK_GARMENT";
  }

  private async onBrowse(t: Turn, text: string, button: string) {
    if (button.startsWith(`${BTN.garment}:`)) return this.startTryOn(t, param(button));
    if (button === BTN.tryAnother) return this.listGarments(t);
    if (button === BTN.newPhoto) return this.askPhoto(t);
    if (button === BTN.order && t.state === "PREVIEW") return this.askPhone(t, false);
    if (button === BTN.orderLook && t.state === "PREVIEW") return this.askPhone(t, true);
    if (button === BTN.completeLook && t.state === "PREVIEW") return this.startLook(t);
    if (button.startsWith(`${BTN.addUnshown}:`) && t.state === "PREVIEW") return this.addUnshown(t, param(button));
    if (button === BTN.askFamily) return this.askFamily(t);
    if (t.state === "AWAIT_SELLER") {
      t.out.push({ kind: "text", text: copy.waitingSeller(t.seller.name), buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)] });
      return this.demoLink(t);
    }
    if (t.state === "ORDERED") return void t.out.push({ kind: "text", text: copy.ordered(), buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)] });
    return this.listGarments(t);
  }

  private async startTryOn(t: Turn, garmentId: string) {
    const { prisma } = this.d;
    if (!this.tryOns) throw new Error("engine: try-on service not wired");
    const garment = await prisma.garment.findFirst({ where: { id: garmentId, sellerId: t.seller.id, active: true } });
    if (!garment || !t.ctx.photoId) return this.listGarments(t);
    t.ctx.garmentId = garment.id;
    t.ctx.wantGarmentId = undefined;
    const r = await this.tryOns.request({ garmentId: garment.id, buyerPhotoId: t.ctx.photoId, buyerId: t.conv.buyerId });
    if (r.kind === "refused") {
      t.out.push({ kind: "text", text: r.reason === "daily_cap" ? copy.capDaily() : copy.capBuyer(this.tryOns.caps.buyerDailyRenders) });
      return;
    }
    if (r.kind === "cached") return this.showResult(t, r.tryOn.id);
    t.activeTryOnId = r.tryOn.id;
    t.state = "TRYON_RUNNING";
    t.out.push({ kind: "status", status: "working" }, { kind: "text", text: copy.working() });
  }

  private async onRunning(t: Turn) {
    // The render may have finished between the event and this message.
    const tryOn = t.activeTryOnId ? await this.d.prisma.tryOn.findUnique({ where: { id: t.activeTryOnId } }) : null;
    if (!tryOn || !["queued", "running"].includes(tryOn.status)) {
      return tryOn ? this.showResult(t, tryOn.id) : this.listGarments(t);
    }
    t.out.push({ kind: "text", text: copy.stillWorking() });
  }

  private async showResult(t: Turn, tryOnId: string) {
    const tryOn = await this.d.prisma.tryOn.findUnique({ where: { id: tryOnId } });
    t.activeTryOnId = null;
    t.out.push({ kind: "status", status: "idle" });
    if (!tryOn || tryOn.status !== "succeeded") {
      t.out.push({ kind: "text", text: copy.renderFailed(tryOn?.error ?? null), buttons: this.afterFailButtons() });
      t.state = "PICK_GARMENT";
      return;
    }
    if (tryOn.verdict === "block" || !tryOn.outputKey) {
      t.out.push({ kind: "text", text: copy.previewBlocked(), buttons: this.afterFailButtons() });
      t.state = "PICK_GARMENT";
      return;
    }
    // a new preview starts without a look
    t.ctx = { ...t.ctx, garmentId: tryOn.garmentId, previewTryOnId: tryOn.id, orderId: undefined, look: undefined, pendingLookId: undefined, lookId: undefined, lookNeckBare: undefined, orderLook: undefined, lookSkipped: undefined, addUnshown: undefined };
    t.out.push({
      kind: "image",
      mediaKey: tryOn.outputKey,
      caption: copy.preview(tryOn.disclosureText),
      buttons: this.previewButtons(),
    });
    t.state = "PREVIEW";
  }

  private previewButtons(): Button[] {
    return [
      this.b(BTN.order, copy.buttons.order),
      this.b(BTN.completeLook, copy.buttons.completeLook),
      this.b(BTN.askFamily, copy.buttons.askFamily),
      this.b(BTN.tryAnother, copy.buttons.tryAnother),
      this.b(BTN.newPhoto, copy.buttons.newPhoto),
    ];
  }

  // ---------------- complete the look ----------------

  /** Accessories of this seller that buyers may pick, by type. */
  private async sellerAccessories(sellerId: string) {
    const all = (await this.d.prisma.accessory.findMany({ where: { sellerId }, orderBy: { createdAt: "asc" } })).filter(accessoryTryable);
    return { earrings: all.filter((a) => a.type === "earring"), necklaces: all.filter((a) => a.type === "necklace") };
  }

  /** "Complete the look": everything here is free; nothing renders until "Show me". */
  private async startLook(t: Turn) {
    const { prisma, blobs } = this.d;
    if (!this.looks) throw new Error("engine: look service not wired");
    const tryOn = t.ctx.previewTryOnId ? await prisma.tryOn.findUnique({ where: { id: t.ctx.previewTryOnId }, include: { garment: true } }) : null;
    if (!tryOn?.outputKey) return this.listGarments(t);
    const { prep } = await this.looks.prepare(tryOn.id);
    if (!prep.crop) {
      return void t.out.push({ kind: "text", text: copy.lookUnavailable(prep.problem ?? "no_face"), buttons: this.previewButtons().filter((b) => b.id !== BTN.completeLook) });
    }
    // two lip shades from the garment's colours (free), each with a small colour swatch to tap
    const garment = await blobs.get(tryOn.garment.photoKey);
    const shades = garment ? (await lipShadesForGarment(garment.bytes)).shades : [];
    const lips: LookDraft["lips"] = [];
    for (const s of shades) {
      const png = await sharp({ create: { width: 96, height: 96, channels: 3, background: s.hex } }).png().toBuffer();
      lips.push({ hex: s.hex, name: s.name, swatchKey: (await storeImage(blobs, "swatch", png)).key });
    }
    t.ctx.look = { tryOnId: tryOn.id, lips };
    t.ctx.lookId = undefined;
    t.ctx.orderLook = undefined;
    t.ctx.lookSkipped = undefined;
    t.ctx.addUnshown = undefined;
    t.state = "LOOK_PICK";
    t.out.push({ kind: "text", text: copy.lookIntro() });
    return this.lookNext(t);
  }

  /** Ask the next open question: earrings -> neck -> necklace -> lip shade -> confirm. */
  private async lookNext(t: Turn): Promise<void> {
    const draft = t.ctx.look;
    if (!draft || !this.looks) return this.leaveLook(t);
    const tryOn = await this.d.prisma.tryOn.findUnique({ where: { id: draft.tryOnId } });
    if (!tryOn) return this.listGarments(t);
    const prep = (tryOn.lookPrep ?? {}) as LookPrep;
    const { earrings, necklaces } = await this.sellerAccessories(t.seller.id);
    const choice = (base: string, a: Accessory) => ({ id: btn(base, a.id), label: copy.accessoryChoice(a.label, a.priceInr), mediaKey: a.photoKey });

    if (draft.earringId === undefined) {
      if (!earrings.length) draft.earringId = null;
      else if (!prep.earsClear) {
        // say why, in plain words, instead of silently hiding the option
        draft.earringId = null;
        t.out.push({ kind: "text", text: copy.earsCovered() });
      } else {
        return void t.out.push({ kind: "choices", text: copy.pickEarring(), choices: earrings.map((a) => choice(BTN.lookEarring, a)), buttons: [this.b(btn(BTN.lookEarring, "none"), copy.buttons.noEarrings)] });
      }
    }
    if (draft.necklaceId === undefined) {
      if (!necklaces.length) draft.necklaceId = null;
      else if (draft.neckBare === undefined && tryOn.closeupKey) {
        // no reliable automatic check exists for the neck: the buyer looks at the close-up and answers
        return void t.out.push({ kind: "image", mediaKey: tryOn.closeupKey, caption: copy.neckQuestion(), buttons: [this.b(BTN.neckYes, copy.buttons.neckYes), this.b(BTN.neckNo, copy.buttons.neckNo)] });
      } else if (draft.neckBare !== true) {
        draft.necklaceId = null;
      } else {
        return void t.out.push({ kind: "choices", text: copy.pickNecklace(), choices: necklaces.map((a) => choice(BTN.lookNecklace, a)), buttons: [this.b(btn(BTN.lookNecklace, "none"), copy.buttons.noNecklace)] });
      }
    }
    if (draft.lip === undefined) {
      if (!draft.lips.length) draft.lip = null;
      else {
        return void t.out.push({
          kind: "choices",
          text: copy.pickLip(),
          choices: draft.lips.map((l, i) => ({ id: btn(BTN.lookLip, String(i)), label: l.name, mediaKey: l.swatchKey })),
          buttons: [this.b(btn(BTN.lookLip, "none"), copy.buttons.noLip)],
        });
      }
    }
    const earring = earrings.find((a) => a.id === draft.earringId);
    const necklace = necklaces.find((a) => a.id === draft.necklaceId);
    if (!earring && !necklace && !draft.lip) {
      t.out.push({ kind: "text", text: copy.lookNothing(), buttons: this.previewButtons() });
      return this.leaveLook(t);
    }
    t.out.push({
      kind: "text",
      text: copy.lookSummary({
        earring: earring ? copy.accessoryChoice(earring.label, earring.priceInr) : null,
        necklace: necklace ? copy.accessoryChoice(necklace.label, necklace.priceInr) : null,
        lip: draft.lip?.name ?? null,
      }),
      buttons: [this.b(BTN.lookShow, copy.buttons.showMe), this.b(BTN.lookRestart, copy.buttons.lookRestart), this.b(BTN.lookBack, copy.buttons.lookBack)],
    });
  }

  private leaveLook(t: Turn) {
    t.ctx.look = undefined;
    t.ctx.pendingLookId = undefined;
    t.state = "PREVIEW";
  }

  private async onLookPick(t: Turn, button: string) {
    const draft = t.ctx.look;
    if (!draft) {
      this.leaveLook(t);
      return this.onBrowse(t, "", button);
    }
    const arg = param(button);
    if (button.startsWith(`${BTN.lookEarring}:`)) draft.earringId = arg === "none" ? null : arg;
    else if (button === BTN.neckYes) draft.neckBare = true;
    else if (button === BTN.neckNo) {
      draft.neckBare = false;
      t.out.push({ kind: "text", text: copy.neckNotBare() });
    } else if (button.startsWith(`${BTN.lookNecklace}:`)) draft.necklaceId = arg === "none" ? null : arg;
    else if (button.startsWith(`${BTN.lookLip}:`)) {
      const l = arg === "none" ? null : draft.lips[Number(arg)];
      draft.lip = l ? { hex: l.hex, name: l.name } : null;
    } else if (button === BTN.lookRestart) {
      t.ctx.look = { tryOnId: draft.tryOnId, lips: draft.lips };
    } else if (button === BTN.lookShow) {
      return this.requestLook(t, draft);
    } else if (button === BTN.lookBack) {
      this.leaveLook(t);
      return void t.out.push({ kind: "text", text: copy.lookBackToPreview(), buttons: this.previewButtons() });
    } else if (button) {
      // any other button (order, try another, new photo...) leaves the look and does that
      this.leaveLook(t);
      return this.onBrowse(t, "", button);
    }
    return this.lookNext(t);
  }

  private async requestLook(t: Turn, draft: LookDraft) {
    if (!this.looks) throw new Error("engine: look service not wired");
    const r = await this.looks.request({ tryOnId: draft.tryOnId, buyerId: t.conv.buyerId, necklaceId: draft.necklaceId, earringId: draft.earringId, lip: draft.lip });
    if (r.kind === "refused") {
      // choices stay, so the buyer can change them; a cap refusal sends them back to the preview
      const cap = r.reason === "daily_cap" || r.reason === "buyer_cap";
      t.out.push({
        kind: "text",
        text: r.reason === "no_face" ? copy.lookUnavailable("no_face") : copy.lookRefused(r.reason, this.tryOns?.caps.buyerDailyLooks ?? DEFAULT_BUYER_DAILY_LOOKS),
        buttons: cap ? this.previewButtons() : [this.b(BTN.lookRestart, copy.buttons.lookRestart), this.b(BTN.lookBack, copy.buttons.lookBack)],
      });
      if (cap) this.leaveLook(t);
      return;
    }
    t.ctx.lookNeckBare = draft.neckBare ?? null;
    if (r.kind === "cached") return this.showLook(t, r.look.id);
    t.ctx.pendingLookId = r.look.id;
    t.state = "LOOK_RUNNING";
    t.out.push({ kind: "status", status: "working" }, { kind: "text", text: copy.lookWorking() });
  }

  private async onLookRunning(t: Turn) {
    const look = t.ctx.pendingLookId ? await this.d.prisma.look.findUnique({ where: { id: t.ctx.pendingLookId } }) : null;
    if (!look || !["queued", "running"].includes(look.status)) return this.showLook(t, look?.id ?? "");
    t.out.push({ kind: "text", text: copy.lookStillWorking() });
  }

  /** Show a finished look as two images: the full-body look and the close-up (the better guide for jewellery). */
  private async showLook(t: Turn, lookId: string) {
    const look = lookId ? await this.d.prisma.look.findUnique({ where: { id: lookId }, include: { necklace: true, earring: true } }) : null;
    t.ctx.look = undefined;
    t.ctx.pendingLookId = undefined;
    t.ctx.addUnshown = undefined;
    t.state = "PREVIEW";
    t.out.push({ kind: "status", status: "idle" });

    // Items that could not be placed: say which and why. Jewellery can still be ordered without a picture.
    const skipped = (Array.isArray(look?.skipped) ? look.skipped : []) as unknown as SkippedItem[];
    const unshown: Accessory[] = [];
    for (const s of skipped) {
      const a = s.kind === "earring" ? look?.earring : s.kind === "necklace" ? look?.necklace : null;
      t.out.push({ kind: "text", text: copy.lookSkipped(s.kind, a?.label ?? "", s.reason) });
      if (a && accessoryTryable(a)) unshown.push(a);
    }
    t.ctx.lookSkipped = unshown.length ? unshown.map((a) => a.id) : undefined;
    const unshownButtons = unshown.map((a) => this.b(btn(BTN.addUnshown, a.id), copy.buttons.addUnshown(a.label)));
    if (unshown.length) t.out.push({ kind: "text", text: copy.lookUnshownOffer() });

    if (!look || look.status !== "succeeded" || !look.outputKey || !look.closeupKey) {
      t.ctx.lookId = undefined;
      // nothing placed at all (reasons given above), or a technical failure
      return void t.out.push({ kind: "text", text: skipped.length ? copy.lookNothingPlaced() : copy.lookFailed(), buttons: [...unshownButtons, ...this.previewButtons()] });
    }
    t.ctx.lookId = look.id;
    const out = new Set(skipped.map((s) => s.kind));
    const hasJewellery = (!!look.necklaceId && !out.has("necklace")) || (!!look.earringId && !out.has("earring"));
    t.out.push({ kind: "image", mediaKey: look.outputKey, caption: copy.lookResult() });
    t.out.push({
      kind: "image",
      mediaKey: look.closeupKey,
      caption: copy.lookCloseup(hasJewellery, !!look.lipHex && !out.has("lip")),
      buttons: [
        this.b(BTN.orderLook, copy.buttons.orderLook),
        this.b(BTN.order, copy.buttons.orderOutfitOnly),
        ...unshownButtons,
        this.b(BTN.completeLook, copy.buttons.changeLook),
        this.b(BTN.tryAnother, copy.buttons.tryAnother),
      ],
    });
  }

  /** Add an item that could not be placed on the photo to the order anyway: no picture, "not shown" on the card. */
  private async addUnshown(t: Turn, accessoryId: string) {
    const offered = t.ctx.lookSkipped ?? [];
    const a = offered.includes(accessoryId) ? await this.d.prisma.accessory.findFirst({ where: { id: accessoryId, sellerId: t.seller.id } }) : null;
    if (!a || !accessoryTryable(a)) return void t.out.push({ kind: "text", text: copy.lookRefused("not_available", 0), buttons: this.previewButtons() });
    const added = new Set([...(t.ctx.addUnshown ?? []), a.id]);
    t.ctx.addUnshown = [...added];
    const rest = await this.d.prisma.accessory.findMany({ where: { id: { in: offered.filter((id) => !added.has(id)) } } });
    t.out.push({
      kind: "text",
      text: copy.unshownAdded(a.label, a.priceInr),
      buttons: [
        this.b(BTN.orderLook, copy.buttons.orderWithAdded),
        this.b(BTN.order, copy.buttons.orderOutfitOnly),
        ...rest.filter(accessoryTryable).map((r) => this.b(btn(BTN.addUnshown, r.id), copy.buttons.addUnshown(r.label))),
        this.b(BTN.tryAnother, copy.buttons.tryAnother),
      ],
    });
  }

  /** "Order this" / "Order this look": ask for a WhatsApp number (optional) before the order goes to the seller. */
  private async askPhone(t: Turn, withLook: boolean) {
    if (!t.ctx.previewTryOnId || !t.ctx.garmentId) return this.listGarments(t);
    // "the look" = the look image (if one was made) plus any items added without a picture
    t.ctx.orderLook = withLook && (!!t.ctx.lookId || !!t.ctx.addUnshown?.length);
    t.out.push({ kind: "text", text: copy.askPhone(t.seller.name), buttons: [this.b(BTN.skipPhone, copy.buttons.skipPhone)] });
    t.state = "AWAIT_PHONE";
  }

  private async onPhone(t: Turn, inc: Incoming, button: string) {
    if (button === BTN.skipPhone) return this.placeOrder(t, null);
    if (button) return this.onBrowse(t, "", button);
    const phone = inc.kind === "text" ? normalizePhone(inc.text) : null;
    if (phone) return this.placeOrder(t, phone);
    t.out.push({ kind: "text", text: copy.phoneInvalid(), buttons: [this.b(BTN.skipPhone, copy.buttons.skipPhone)] });
  }

  private async placeOrder(t: Turn, phone: string | null) {
    const { prisma } = this.d;
    const tryOnId = t.ctx.previewTryOnId;
    const tryOn = tryOnId ? await prisma.tryOn.findUnique({ where: { id: tryOnId } }) : null;
    if (!tryOn || !t.ctx.garmentId) return this.listGarments(t);
    // "Order this look": the jewellery in the look goes on the order; the lip shade is only a styling suggestion.
    const look =
      t.ctx.orderLook && t.ctx.lookId
        ? await prisma.look.findFirst({ where: { id: t.ctx.lookId, tryOnId: tryOn.id, status: "succeeded" }, include: { necklace: true, earring: true } })
        : null;
    const lookItems: LookItem[] = [];
    const ordered: Array<{ a: Accessory; shown: boolean }> = [];
    if (look) {
      // an item that was left out of the look is not in the picture, so it is never ordered "as part of the look"
      const skipped = new Set(((Array.isArray(look.skipped) ? look.skipped : []) as unknown as SkippedItem[]).map((s) => s.kind));
      for (const a of [look.earring, look.necklace]) {
        if (a && !skipped.has(a.type)) ordered.push({ a, shown: true });
      }
      if (look.lipHex && !skipped.has("lip")) lookItems.push({ kind: "lip", label: look.lipName ?? look.lipHex, priceInr: null, ordered: false, fromSellerPhoto: false, hex: look.lipHex });
    }
    if (t.ctx.orderLook && t.ctx.addUnshown?.length) {
      // added by the buyer although it could not be placed on the photo: on the order, "not shown" on the card
      const offered = new Set(t.ctx.lookSkipped ?? []);
      const extra = await prisma.accessory.findMany({ where: { id: { in: t.ctx.addUnshown.filter((id) => offered.has(id)) }, sellerId: t.seller.id }, orderBy: { createdAt: "asc" } });
      for (const a of extra.filter(accessoryTryable)) ordered.push({ a, shown: false });
    }
    lookItems.unshift(...ordered.map(({ a, shown }) => ({ kind: a.type, label: a.label, priceInr: a.priceInr, ordered: true, fromSellerPhoto: shown, shown })));
    const order = await prisma.order.create({
      data: {
        sellerId: t.seller.id,
        buyerId: t.conv.buyerId,
        garmentId: t.ctx.garmentId,
        conversationId: t.conv.id,
        tryOnId: tryOn.id,
        disclosureText: tryOn.disclosureText,
        pixelSummary: { verdict: tryOn.verdict, blockReason: tryOn.blockReason, pixelChecks: tryOn.pixelChecks ?? null } as Prisma.InputJsonValue,
        buyerWhatsapp: phone,
        lookId: look?.id ?? null,
        lookNeckBare: t.ctx.orderLook ? (t.ctx.lookNeckBare ?? null) : null,
        lookItems: lookItems.length ? (lookItems as unknown as Prisma.InputJsonValue) : undefined,
        items: ordered.length ? { create: ordered.map(({ a, shown }) => ({ accessoryId: a.id, type: a.type, label: a.label, priceInr: a.priceInr, shown })) } : undefined,
      },
    });
    t.ctx.orderId = order.id;
    t.out.push({ kind: "text", text: copy.orderSent(t.seller.name, phone) });
    this.demoLink(t);
    t.state = "AWAIT_SELLER";
  }

  /** "Ask family": a public 7-day link to this preview only. The buyer chose to share it. */
  private async askFamily(t: Turn) {
    const { prisma } = this.d;
    if (!this.family) throw new Error("engine: family vote service not wired");
    const tryOn = t.ctx.previewTryOnId
      ? await prisma.tryOn.findUnique({ where: { id: t.ctx.previewTryOnId }, include: { garment: true } })
      : null;
    if (!tryOn?.outputKey || tryOn.verdict === "block") {
      return void t.out.push({ kind: "text", text: copy.familyUnavailable(), buttons: this.afterFailButtons() });
    }
    const { vote } = await this.family.create({ tryOnId: tryOn.id, buyerId: t.conv.buyerId, conversationId: t.conv.id, garmentLabel: tryOn.garment.label });
    const buttons = t.state === "PREVIEW" ? this.previewButtons().filter((b) => b.id !== BTN.askFamily) : [this.b(BTN.tryAnother, copy.buttons.tryAnother)];
    t.out.push(
      { kind: "text", text: copy.familyIntro(), buttons },
      { kind: "link", label: copy.familyShareWhatsapp(), href: waLink(copy.familyShareText(tryOn.garment.label, links.vote(this.d.baseUrl, vote.token))) },
      { kind: "link", label: copy.familyOpenLink(), href: links.vote("", vote.token) },
    );
  }

  private demoLink(t: Turn) {
    // Only the seeded demo seller shows this, so one person can play both sides.
    if (t.seller.isDemo) t.out.push({ kind: "link", label: copy.demoSellerLink(), href: `/seller/${t.seller.slug}` });
  }

  private async deletePhotos(t: Turn) {
    const summary = await this.d.consent.deletePhotos(t.conv.buyerId);
    t.out.push({ kind: "text", text: copy.deleted(summary) });
    const consented = await this.d.consent.hasConsent(t.conv.buyerId);
    t.ctx = {};
    t.activeTryOnId = null;
    if (consented) return this.askPhoto(t);
    t.state = "NEW";
  }

  private async revoke(t: Turn) {
    const summary = await this.d.consent.revoke(t.conv.buyerId);
    t.out.push({ kind: "text", text: copy.revoked(summary) });
    t.ctx = {};
    t.activeTryOnId = null;
    t.state = "NEW";
  }

  private afterFailButtons(): Button[] {
    return [this.b(BTN.tryAnother, copy.buttons.tryAnother), this.b(BTN.newPhoto, copy.buttons.newPhoto)];
  }

  // ---------------- plumbing ----------------

  private b(id: string, label: string): Button {
    return { id, label };
  }

  private turn(conv: Conversation, seller: Seller): Turn {
    return { conv, seller, ctx: { ...((conv.context as Ctx) ?? {}) }, state: conv.state, activeTryOnId: conv.activeTryOnId, out: [] };
  }

  private async recordIncoming(t: Turn, inc: Incoming): Promise<ChatMessage[]> {
    // Images are recorded as text: the photo itself is stored (or not) by the photo handler.
    // A WhatsApp number is stored only on the order (deleted with the photos), so the
    // chat history keeps a masked copy.
    const phone = t.state === "AWAIT_PHONE" && inc.kind === "text" ? normalizePhone(inc.text) : null;
    const body =
      phone
        ? { kind: "in_text", text: `📱 ••••••${phone.slice(-4)}` }
        : inc.kind === "text"
        ? { kind: "in_text", text: inc.text }
        : inc.kind === "button"
          ? { kind: "in_text", text: inc.label ?? inc.id }
          : { kind: "in_text", text: "📷 Photo" };
    const row = await this.d.prisma.message.create({ data: { conversationId: t.conv.id, direction: "in", kind: "text", body } });
    return [toChat(row)];
  }

  private async commit(t: Turn): Promise<ChatMessage[]> {
    const { prisma } = this.d;
    await prisma.conversation.update({
      where: { id: t.conv.id },
      data: { state: t.state, context: t.ctx as Prisma.InputJsonValue, activeTryOnId: t.activeTryOnId },
    });
    const rows = [];
    for (const o of t.out) {
      rows.push(await prisma.message.create({ data: { conversationId: t.conv.id, direction: "out", kind: o.kind, body: o as unknown as Prisma.InputJsonValue } }));
    }
    return rows.map(toChat);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

export { orderRef } from "../orders/cardData";

function toChat(r: { id: string; direction: string; createdAt: Date; body: unknown }): ChatMessage {
  return { id: r.id, direction: r.direction as "in" | "out", createdAt: r.createdAt.toISOString(), body: r.body as ChatMessage["body"] };
}
