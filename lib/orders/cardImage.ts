import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { copy } from "../engine/copy";
import { sha256, type BlobStore } from "../storage/blobs";
import { withImageSlot } from "../storage/imageLimit";
import type { OrderCardData } from "./cardData";

/**
 * The order confirmation card as one shareable image (for WhatsApp): try-on,
 * garment photo, label, price, order number, disclosure. Built from the same
 * OrderCardData as the chat card, so both always say the same thing.
 * Text is drawn with the bundled Noto Sans (SIL OFL, assets/fonts): it has
 * the ₹ sign and Devanagari, and doesn't depend on the host's fonts.
 */

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

export const CARD_W = 1080;
const PAD = 48;
const TEXT_W = CARD_W - 2 * PAD;
/** try-on panel height follows the image's proportions, within these bounds */
const PHOTO_MIN_H = 600;
const PHOTO_MAX_H = 1240;
const THUMB_W = 200;
const THUMB_H = 260;
const THUMB_GAP = 28;

const C = { bg: "#fbf7f2", ink: "#1f2328", muted: "#5d6470", panel: "#efe7dc", accent: "#0f7a55", rule: "#e3d9cc" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One block of wrapped text as a transparent PNG (Pango markup, escaped). */
async function text(s: string, opts: { size: number; bold?: boolean; color?: string; width?: number }) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${opts.color ?? C.ink}">${esc(s)}</span>`,
      fontfile: opts.bold ? BOLD : REGULAR,
      font: `Noto Sans${opts.bold ? " Bold" : ""} ${opts.size}`,
      width: opts.width ?? TEXT_W,
      dpi: 72,
      rgba: true,
      wrap: "word",
      spacing: Math.round(opts.size * 0.25),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

const roundedMask = (w: number, h: number, r: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);

async function rounded(input: Uint8Array | Buffer, w: number, h: number, fit: "contain" | "cover", r: number, background = C.panel) {
  return sharp(input)
    .rotate()
    .resize(w, h, { fit, background, position: "top" })
    .composite([{ input: roundedMask(w, h, r), blend: "dest-in" }])
    .png()
    .toBuffer();
}

const checkIcon = (size: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${C.accent}"/><path d="M7 12.5l3.2 3.2 6.6-7" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );

export interface CardImageInput {
  card: OrderCardData;
  tryOn: Uint8Array | null;
  garment: Uint8Array | null;
}

/** Render the card as a JPEG (1080 px wide; height depends on the text). */
export async function renderCardImage({ card, tryOn, garment }: CardImageInput): Promise<{ bytes: Buffer; width: number; height: number }> {
  return withImageSlot(async () => {
    // details sit left of the garment thumbnail (the thumbnail never covers the try-on)
    const infoW = garment ? TEXT_W - THUMB_W - THUMB_GAP : TEXT_W;
    const title = await text(card.title, { size: 46, bold: true, width: TEXT_W - 70 });
    const shop = await text(card.sellerName, { size: 30, color: C.muted, width: TEXT_W - 70 });
    const inr = (n: number | null) => (n != null ? `₹${n.toLocaleString("en-IN")}` : "");
    const label = await text(card.garmentLabel, { size: 42, bold: true, width: infoW });
    const meta = await text([card.priceInr != null ? inr(card.priceInr) : null, `Order ${card.orderRef}`].filter(Boolean).join("  ·  "), { size: 34, width: infoW });
    // jewellery added to the order, with prices and a total; then what the image shows but the order doesn't include
    const extras = [];
    for (const e of card.extras) extras.push(await text(`+ ${e.label}${e.priceInr != null ? `  ·  ${inr(e.priceInr)}` : ""}`, { size: 30, width: infoW }));
    const total = card.totalInr != null ? await text(copy.cardTotal(card.totalInr), { size: 36, bold: true, width: infoW }) : null;
    const styling = card.styling.length ? await text(copy.cardStyling(card.styling), { size: 27, color: C.muted, width: infoW }) : null;
    const disclosure = card.disclosure ? await text(card.disclosure, { size: 27, color: C.muted, width: infoW }) : null;
    const footer = await text(copy.cardImageFooter(), { size: 24, color: C.muted });

    const layers: OverlayOptions[] = [];
    let y = PAD;
    layers.push({ input: checkIcon(54), left: PAD, top: y });
    layers.push({ input: title.input, left: PAD + 70, top: y });
    layers.push({ input: shop.input, left: PAD + 70, top: y + title.height + 12 });
    y += Math.max(54, title.height + 12 + shop.height) + 32;

    const photoW = CARD_W - 2 * PAD;
    let photoH = 300;
    if (tryOn) {
      const m = await sharp(tryOn).metadata();
      const [w, h] = (m.orientation ?? 1) >= 5 ? [m.height, m.width] : [m.width, m.height];
      photoH = Math.min(PHOTO_MAX_H, Math.max(PHOTO_MIN_H, Math.round((photoW * (h ?? 4)) / (w ?? 3))));
      layers.push({ input: await rounded(tryOn, photoW, photoH, "contain", 28), left: PAD, top: y });
    } else {
      const none = await text(copy.cardImageNoPhoto(), { size: 30, color: C.muted, width: photoW - 80 });
      layers.push({ input: await sharp({ create: { width: photoW, height: photoH, channels: 4, background: C.panel } }).composite([{ input: roundedMask(photoW, photoH, 28), blend: "dest-in" }]).png().toBuffer(), left: PAD, top: y });
      layers.push({ input: none.input, left: PAD + 40, top: y + photoH / 2 - Math.round(none.height / 2) });
    }
    y += photoH + 36;

    const infoTop = y;
    layers.push({ input: label.input, left: PAD, top: y });
    y += label.height + 18;
    layers.push({ input: meta.input, left: PAD, top: y });
    y += meta.height + 24;
    for (const e of extras) {
      layers.push({ input: e.input, left: PAD, top: y });
      y += e.height + 14;
    }
    if (total) {
      layers.push({ input: total.input, left: PAD, top: y + 4 });
      y += total.height + 28;
    } else if (extras.length) y += 10;
    if (styling) {
      layers.push({ input: styling.input, left: PAD, top: y });
      y += styling.height + 20;
    }
    if (disclosure) {
      layers.push({ input: disclosure.input, left: PAD, top: y });
      y += disclosure.height + 24;
    }
    if (garment) {
      // the garment as the seller photographed it, beside the details
      const frame = 6;
      const tx = CARD_W - PAD - THUMB_W - 2 * frame;
      layers.push({ input: await sharp({ create: { width: THUMB_W + 2 * frame, height: THUMB_H + 2 * frame, channels: 4, background: C.rule } }).composite([{ input: roundedMask(THUMB_W + 2 * frame, THUMB_H + 2 * frame, 20), blend: "dest-in" }]).png().toBuffer(), left: tx, top: infoTop });
      layers.push({ input: await rounded(garment, THUMB_W, THUMB_H, "contain", 16, "#ffffff"), left: tx + frame, top: infoTop + frame });
      y = Math.max(y, infoTop + THUMB_H + 2 * frame + 28);
    }
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_W}" height="2"><rect width="${TEXT_W}" height="2" fill="${C.rule}"/></svg>`), left: PAD, top: y });
    y += 20;
    layers.push({ input: footer.input, left: PAD, top: y });
    const height = y + footer.height + PAD;

    const bytes = await sharp({ create: { width: CARD_W, height, channels: 3, background: C.bg } })
      .composite(layers)
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    return { bytes, width: CARD_W, height };
  });
}

/** Render and store the card; returns the blob key (content-addressed under card/). */
export async function storeCardImage(blobs: BlobStore, input: CardImageInput): Promise<string> {
  const img = await renderCardImage(input);
  const key = `card/${sha256(img.bytes).slice(0, 32)}.jpg`;
  await blobs.put(key, img.bytes, { contentType: "image/jpeg", width: img.width, height: img.height });
  return key;
}
