/** Seller-facing text (seller page). English only for now; keep all text here for Hindi later. */
import type { AccessoryProblem } from "../gate/accessoryGate";
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

/** Jewellery photo gate: what to send instead. The try-on draws the photo as it is, so the shape matters. */
const accessoryFix: Record<"earring" | "necklace", Record<AccessoryProblem, string>> = {
  earring: {
    too_small: "The photo is too small. Send a larger, sharper photo (at least 300 pixels on the short side).",
    busy_background: "Put the earring on a plain surface (a sheet of white paper works) with nothing else in the picture: no card, no print, no hand.",
    not_found: "We couldn't find the earring in the photo. Put it on a plain surface that contrasts with it, and fill most of the frame.",
    cut_off: "Part of the earring is cut off at the edge. Step back a little so the whole earring fits, with some space around it.",
    several_items: "Photograph one earring only, from the front.",
    pair: "This looks like a pair. The try-on needs one earring: we've cropped the photo to the left one. Check the crop below and confirm it.",
    not_worn_shape: "",
  },
  necklace: {
    too_small: "The photo is too small. Send a larger, sharper photo (at least 300 pixels on the short side).",
    busy_background: "Lay the necklace on a plain surface (a sheet of white paper works) with nothing else in the picture.",
    not_found: "We couldn't find the necklace in the photo. Lay it on a plain surface that contrasts with it.",
    cut_off: "Part of the necklace is cut off at the edge. Step back so the whole necklace fits, with some space around it.",
    several_items: "Photograph one necklace only.",
    pair: "",
    not_worn_shape: "Lay the necklace open in a U, the way it sits when worn: clasp ends at the top left and right, pendant at the bottom centre. Don't coil it or close it into a circle. It will be drawn on the buyer exactly as it lies in the photo.",
  },
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

  accessoryAdvice: (type: "earring" | "necklace", problems: AccessoryProblem[]): string =>
    problems
      .map((p) => accessoryFix[type][p])
      .filter(Boolean)
      .join(" "),
  accessoryTypes: { earring: "Earrings", necklace: "Necklace" } as const,
  accessoryBest: {
    earring: "Best: ONE earring, from the front, on plain white paper. We show it on both ears.",
    necklace: "Best: the necklace laid open in a U (as worn) on plain white paper, whole necklace in the picture.",
  } as const,
  accessoryStatus: { approved: "Ready for looks", rejected: "Photo not usable", needs_review: "Check the crop", pending: "Checking…" } as const,

  // Order approval: what the look image shows
  lookFromYourPhotos: "Drawn from your photos",
  lookStyling: "Styling suggestion, not something you sell",
  lookNotShown: "Ordered, but NOT in the picture (it could not be placed on the buyer's photo)",
  lookOrdered: "ordered",
  lookShownOnly: "shown only, not ordered",
  neckAnswer: (bare: boolean | null) =>
    bare === true ? "Buyer said their neck is bare in the try-on." : bare === false ? "Buyer said the try-on already shows jewellery at the neck (illustrative, not included), so no necklace was offered." : null,

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
