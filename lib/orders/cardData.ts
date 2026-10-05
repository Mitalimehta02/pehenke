import { copy } from "../engine/copy";

/**
 * Everything an order confirmation card shows, in one structure. The web chat
 * renders it as a chat card; the WhatsApp phase will render the same data into
 * a single shareable image (try-on + garment + price + order number +
 * disclosure), so both channels stay in sync.
 */
export interface OrderCardData {
  title: string;
  /** blob key of the try-on image; null if the buyer deleted their photos */
  imageKey: string | null;
  garmentLabel: string;
  priceInr: number | null;
  orderRef: string;
  sellerName: string;
  disclosure: string | null;
  /** display lines, in order (garment + price, order ref + seller, disclosure) */
  lines: string[];
}

export const orderRef = (id: string) => `#${id.slice(-6).toUpperCase()}`;

export function buildOrderCard(o: {
  id: string;
  disclosureText: string | null;
  garment: { label: string; priceInr: number | null };
  seller: { name: string };
  tryOn: { outputKey: string | null } | null;
}): OrderCardData {
  const ref = orderRef(o.id);
  const { title, lines } = copy.card({ label: o.garment.label, priceInr: o.garment.priceInr, orderRef: ref, disclosure: o.disclosureText, seller: o.seller.name });
  return {
    title,
    imageKey: o.tryOn?.outputKey ?? null,
    garmentLabel: o.garment.label,
    priceInr: o.garment.priceInr,
    orderRef: ref,
    sellerName: o.seller.name,
    disclosure: o.disclosureText,
    lines,
  };
}
