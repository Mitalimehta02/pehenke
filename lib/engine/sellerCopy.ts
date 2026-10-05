/** Seller-facing text (seller page). English only for now; keep all text here for Hindi later. */
import type { GateProblem, GateResult } from "../gate/garmentGate";

const fix: Record<GateProblem, string> = {
  too_small: "The photo is too small. Send a larger, sharper photo (at least 512 pixels on the long side).",
  glass_or_reflection: "Take the photo without glass in front, and avoid shiny reflections on the fabric.",
  folded: "Don't fold it: hang it up or put it on a mannequin so the whole shape shows.",
  cropped: "Step back so the whole item fits in the photo, top to bottom.",
  holding_object: "The model shouldn't hold a bag or phone. Or use a mannequin.",
  extra_layers: "Remove any jacket, vest or shawl that isn't part of what you're selling.",
  multiple_garments: "Photograph one item at a time.",
  too_dark_or_blurry: "Use daylight and hold the phone steady.",
  not_a_garment: "Send a photo of the item itself.",
};

const BEST = "Best: the whole item on a mannequin or hanger against a plain wall, nothing else in the picture.";

export const sellerCopy = {
  gateAdvice: (r: GateResult): string => {
    if (r.status === "needs_review") {
      return `We couldn't check this photo automatically right now. Please confirm it shows the whole item, with no glass or reflections, nothing held, and no extra layers. ${BEST}`;
    }
    return [...r.problems.map((p) => fix[p]), BEST].join(" ");
  },
  gateStatus: { approved: "Ready for try-on", rejected: "Photo not usable", needs_review: "Needs your check", pending: "Checking…" } as const,
  checklist: [
    "The whole item is visible, top to bottom",
    "No glass, no strong reflections",
    "Nobody is holding a bag or phone",
    "No jacket, vest or shawl over the item",
  ],
  photoTypes: { flatlay: "Laid flat", hanger: "On a hanger", mannequin: "On a mannequin", worn: "Worn by a model" } as const,
  categories: { upper_body: "Top only", full_body: "Full outfit" } as const,
  outcomes: { pending: "Not delivered yet", delivered: "Delivered", refused: "Refused at door", cancelled: "Cancelled" } as const,

  // WhatsApp messages the seller sends (prefilled in wa.me links; the seller can edit before sending)
  waShop: (shop: string, url: string) => `Hi! You can now see any outfit from ${shop} on yourself before you order 👗 Just send one photo here: ${url}`,
  waGarment: (label: string, priceInr: number | null, url: string) =>
    `See our ${label}${priceInr != null ? ` (₹${priceInr.toLocaleString("en-IN")})` : ""} on you before you order 👗 Send one photo here: ${url}`,
  waCard: (shop: string, ref: string, label: string, url: string) =>
    `Hi! Your order ${ref} (${label}) from ${shop} is confirmed ✅\nHere's what you ordered, on you: ${url}`,
  waDispatched: (shop: string, ref: string, label: string, url: string) =>
    `Good news! Your order ${ref} (${label}) from ${shop} has been dispatched 🚚\nHere's what you ordered, on you: ${url}`,
  waSellerLink: (shop: string, url: string) =>
    `Your PehenKe seller page for ${shop}. Keep this link private: anyone who has it can manage your shop.\n${url}`,
};
