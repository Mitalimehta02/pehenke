import { copy } from "../engine/copy";

/**
 * Everything an order confirmation card shows, in one structure. The web chat
 * renders it as a chat card; the shareable card image (WhatsApp) is drawn from
 * the same data, so both channels stay in sync.
 *
 * With "complete the look": jewellery the buyer added is listed under
 * "Ordered" with prices and a total; anything the image shows that is not part
 * of the order (the lip shade, always) is listed as a styling suggestion.
 */

/** One thing a look image shows, stored on the order (Order.lookItems). */
export interface LookItem {
  kind: "earring" | "necklace" | "lip";
  label: string;
  priceInr: number | null;
  /** part of the order (jewellery only; a lip shade is never sold) */
  ordered: boolean;
  /** drawn from the seller's own product photo (jewellery) vs a styling suggestion (lip shade) */
  fromSellerPhoto: boolean;
  /** false: ordered, but it could not be placed on the buyer's photo, so the picture doesn't show it */
  shown?: boolean;
  hex?: string;
}

export interface OrderCardData {
  title: string;
  /** blob key of the image: the look if one was ordered, else the try-on; null if the buyer deleted their photos */
  imageKey: string | null;
  /** head-and-shoulders close-up of the look, if any */
  closeupKey: string | null;
  garmentLabel: string;
  priceInr: number | null;
  /** jewellery added to the order */
  extras: Array<{ label: string; priceInr: number | null }>;
  /** garment + jewellery, when every ordered item has a price and there is jewellery */
  totalInr: number | null;
  /** shown in the image, not part of the order */
  styling: string[];
  orderRef: string;
  sellerName: string;
  disclosure: string | null;
  /** display lines, in order */
  lines: string[];
}

export const orderRef = (id: string) => `#${id.slice(-6).toUpperCase()}`;

const KIND = { earring: "Earrings", necklace: "Necklace", lip: "Lip colour" } as const;
/** Marks an ordered item that the card's picture does not show. */
export const NOT_SHOWN = "(not shown)";
export const lookItemLabel = (i: Pick<LookItem, "kind" | "label">) => `${KIND[i.kind]}: ${i.label}`;

export function buildOrderCard(o: {
  id: string;
  disclosureText: string | null;
  garment: { label: string; priceInr: number | null };
  seller: { name: string };
  tryOn: { outputKey: string | null } | null;
  look?: { outputKey: string | null; closeupKey: string | null } | null;
  lookItems?: unknown;
}): OrderCardData {
  const ref = orderRef(o.id);
  const items = (Array.isArray(o.lookItems) ? o.lookItems : []) as LookItem[];
  const extras = items.filter((i) => i.ordered).map((i) => ({ label: `${lookItemLabel(i)}${i.shown === false ? ` ${NOT_SHOWN}` : ""}`, priceInr: i.priceInr }));
  const styling = items.filter((i) => !i.ordered).map((i) => (i.kind === "lip" ? `lip colour (${i.label})` : lookItemLabel(i).toLowerCase()));
  const priced = [o.garment.priceInr, ...extras.map((e) => e.priceInr)];
  const totalInr = extras.length && priced.every((p) => p != null) ? priced.reduce<number>((n, p) => n + (p as number), 0) : null;
  // the look image only while it exists; the plain try-on otherwise (styling only applies to the look image)
  const lookShown = items.some((i) => i.shown !== false) && !!o.look?.outputKey;
  const { title, lines } = copy.card({ label: o.garment.label, priceInr: o.garment.priceInr, orderRef: ref, disclosure: o.disclosureText, seller: o.seller.name, extras, totalInr, styling: lookShown ? styling : [] });
  return {
    title,
    imageKey: lookShown ? o.look!.outputKey : (o.tryOn?.outputKey ?? null),
    closeupKey: lookShown ? (o.look!.closeupKey ?? null) : null,
    garmentLabel: o.garment.label,
    priceInr: o.garment.priceInr,
    extras,
    totalInr,
    styling: lookShown ? styling : [],
    orderRef: ref,
    sellerName: o.seller.name,
    disclosure: o.disclosureText,
    lines,
  };
}
