import type { ConsentService } from "../consent/service";
import type { FamilyVoteService, VoteEvent } from "../family/service";
import type { Conversation, ConvState, Garment, Prisma, PrismaClient, Seller } from "../generated/prisma/client";
import { links, waLink } from "../links";
import { normalizePhone } from "../orders/phone";
import { checkBuyerPhoto } from "../photos/buyerPhoto";
import type { BlobStore } from "../storage/blobs";
import { storeImage } from "../storage/blobs";
import { buildOrderCard } from "../orders/cardData";
import type { TryOnService } from "../tryon/service";
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
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: EngineDeps) {
    this.tryOns = d.tryOns;
    this.family = d.family;
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
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { garment: true, tryOn: true, seller: true } });
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
    if (button === BTN.order && t.state === "PREVIEW") return this.askPhone(t);
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
    t.ctx = { ...t.ctx, garmentId: tryOn.garmentId, previewTryOnId: tryOn.id, orderId: undefined };
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
      this.b(BTN.askFamily, copy.buttons.askFamily),
      this.b(BTN.tryAnother, copy.buttons.tryAnother),
      this.b(BTN.newPhoto, copy.buttons.newPhoto),
    ];
  }

  /** "Order this": ask for a WhatsApp number (optional) before the order goes to the seller. */
  private async askPhone(t: Turn) {
    if (!t.ctx.previewTryOnId || !t.ctx.garmentId) return this.listGarments(t);
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
