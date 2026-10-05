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
const PHOTO_H = 1000;
const THUMB_W = 250;
const THUMB_H = 320;

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
    const title = await text(card.title, { size: 46, bold: true, width: TEXT_W - 70 });
    const shop = await text(card.sellerName, { size: 30, color: C.muted, width: TEXT_W - 70 });
    const label = await text(card.garmentLabel, { size: 44, bold: true });
    const meta = await text([card.priceInr != null ? `₹${card.priceInr.toLocaleString("en-IN")}` : null, `Order ${card.orderRef}`].filter(Boolean).join("  ·  "), { size: 36 });
    const disclosure = card.disclosure ? await text(card.disclosure, { size: 28, color: C.muted }) : null;
    const footer = await text(copy.cardImageFooter(), { size: 24, color: C.muted });

    const layers: OverlayOptions[] = [];
    let y = PAD;
    layers.push({ input: checkIcon(54), left: PAD, top: y });
    layers.push({ input: title.input, left: PAD + 70, top: y });
    layers.push({ input: shop.input, left: PAD + 70, top: y + title.height + 12 });
    y += Math.max(54, title.height + 12 + shop.height) + 32;

    const photoW = CARD_W - 2 * PAD;
    if (tryOn) {
      layers.push({ input: await rounded(tryOn, photoW, PHOTO_H, "contain", 28), left: PAD, top: y });
    } else {
      const none = await text(copy.cardImageNoPhoto(), { size: 30, color: C.muted, width: photoW - 80 });
      layers.push({ input: await sharp({ create: { width: photoW, height: 300, channels: 4, background: C.panel } }).composite([{ input: roundedMask(photoW, 300, 28), blend: "dest-in" }]).png().toBuffer(), left: PAD, top: y });
      layers.push({ input: none.input, left: PAD + 40, top: y + 150 - Math.round(none.height / 2) });
    }
    const photoH = tryOn ? PHOTO_H : 300;
    if (garment && tryOn) {
      // garment thumbnail with a white frame, bottom-right of the try-on
      const frame = 8;
      const thumb = await rounded(garment, THUMB_W, THUMB_H, "contain", 16, "#ffffff");
      const fx = CARD_W - PAD - 24 - THUMB_W - 2 * frame;
      const fy = y + photoH - 24 - THUMB_H - 2 * frame;
      layers.push({ input: await sharp({ create: { width: THUMB_W + 2 * frame, height: THUMB_H + 2 * frame, channels: 4, background: "#ffffff" } }).composite([{ input: roundedMask(THUMB_W + 2 * frame, THUMB_H + 2 * frame, 22), blend: "dest-in" }]).png().toBuffer(), left: fx, top: fy });
      layers.push({ input: thumb, left: fx + frame, top: fy + frame });
    }
    y += photoH + 36;

    layers.push({ input: label.input, left: PAD, top: y });
    y += label.height + 18;
    layers.push({ input: meta.input, left: PAD, top: y });
    y += meta.height + 24;
    if (disclosure) {
      layers.push({ input: disclosure.input, left: PAD, top: y });
      y += disclosure.height + 24;
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
