import type { ConsentService } from "../consent/service";
import type { Conversation, ConvState, Prisma, PrismaClient, Seller } from "../generated/prisma/client";
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
 * Asynchronous results (finished renders, seller decisions) arrive through
 * onTryOnFinished / onOrderDecided and are appended to the same conversation;
 * adapters deliver every stored outgoing message.
 *
 *   NEW -> AWAIT_CONSENT -> AWAIT_PHOTO -> PICK_GARMENT -> TRYON_RUNNING -> PREVIEW
 *       -> AWAIT_SELLER -> ORDERED            (DECLINED: consent refused)
 *   any state: "delete my photos" | "stop" | "help"
 */

export interface EngineDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  consent: ConsentService;
  /** set after construction (the try-on service calls back into the engine) */
  tryOns?: TryOnService;
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
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: EngineDeps) {
    this.tryOns = d.tryOns;
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
        if (turn.state === "NEW") await this.greet(turn);
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
        if (turn.state === "AWAIT_SELLER") turn.state = "ORDERED";
      } else if (order.cardStatus === "rejected") {
        turn.out.push({ kind: "text", text: copy.orderRejected(order.sellerNote), buttons: [this.b(BTN.tryAnother, copy.buttons.tryAnother)] });
        if (turn.state === "AWAIT_SELLER") turn.state = "PICK_GARMENT";
      }
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
      case "PICK_GARMENT":
      case "PREVIEW":
      case "ORDERED":
      case "AWAIT_SELLER":
        return this.onBrowse(t, text, button);
      case "TRYON_RUNNING":
        return this.onRunning(t);
    }
  }

  private async greet(t: Turn) {
    t.out.push({ kind: "text", text: copy.greeting(t.seller.name) });
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
      return this.listGarments(t);
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
      return this.listGarments(t);
    }
    t.out.push({ kind: "text", text: copy.photoReminder() });
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
    if (button === BTN.order && t.state === "PREVIEW") return this.placeOrder(t);
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
      buttons: [this.b(BTN.order, copy.buttons.order), this.b(BTN.tryAnother, copy.buttons.tryAnother), this.b(BTN.newPhoto, copy.buttons.newPhoto)],
    });
    t.state = "PREVIEW";
  }

  private async placeOrder(t: Turn) {
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
      },
    });
    t.ctx.orderId = order.id;
    t.out.push({ kind: "text", text: copy.orderSent(t.seller.name) });
    this.demoLink(t);
    t.state = "AWAIT_SELLER";
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
    const body =
      inc.kind === "text"
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
