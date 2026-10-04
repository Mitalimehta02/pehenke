import type { RenderAudit } from "../audit/types";

/**
 * Decides whether a try-on render can go on the buyer's order confirmation
 * card. Combines the vision-model audit with the pixel checks: either can
 * block. If the audit is unavailable, pixel checks alone decide and the card
 * carries a generic disclosure; the pipeline never stops for a missing audit.
 */

export type CardVerdict = "send" | "send_with_disclosure" | "block";
export type AuditStatus = "ok" | "unavailable" | "not_configured";

export interface VerdictInput {
  /** seller's garment label, e.g. "saree", "kurti", "men's kurta" */
  garmentLabel: string;
  /** framing of the buyer's photo */
  framing: "full" | "chest" | "unknown";
  audit: RenderAudit | undefined;
  auditStatus: AuditStatus;
  pixel: {
    /** bad-render check: the clothing region is nearly unchanged (original clothes returned) */
    regionUnchanged: boolean;
    /** garment-length check, when it ran */
    length?: { flagged: boolean; expected: string; hemPos: number };
  };
}

export interface VerdictResult {
  card_verdict: CardVerdict;
  /** exact line for the card when the verdict is send_with_disclosure */
  disclosure_text: string | null;
  /** why it was blocked (all reasons, joined) */
  block_reason: string | null;
  /** what to do next, or null when nothing is needed */
  next_step: string | null;
  audit_status: AuditStatus;
}

/** Pieces a buyer expects to come with a garment, so inventing them is disclosed, not blocked. */
const COMPANIONS: Array<{ garment: RegExp; piece: RegExp; name: string }> = [
  { garment: /saree|sari/i, piece: /blouse|choli|petticoat|underskirt/i, name: "blouse" },
  { garment: /lehenga|ghagra/i, piece: /blouse|choli/i, name: "blouse" },
  { garment: /lehenga|ghagra/i, piece: /dupatta/i, name: "dupatta" },
  {
    garment: /kurta|kurti/i,
    piece: /leggings?|churidar|salwar|shalwar|pants|trousers|palazzo|pyjama|pajama|bottoms?|jeans|skirt/i,
    name: "bottoms",
  },
];

function companionName(label: string, item: string): string | undefined {
  return COMPANIONS.find((c) => c.garment.test(label) && c.piece.test(item))?.name;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function joinList(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function decideCardVerdict(input: VerdictInput): VerdictResult {
  const { audit, pixel, garmentLabel, framing, auditStatus } = input;
  const label = cap(garmentLabel.trim());
  const blocks: Array<{ reason: string; step: string }> = [];

  // ---- pixel checks: either can block ----
  if (pixel.regionUnchanged) {
    blocks.push({
      reason: "clothing region nearly unchanged (original clothes returned)",
      step: "Ask the buyer for a front-facing photo in plain, fitted clothes.",
    });
  }
  if (pixel.length?.flagged) {
    blocks.push({
      reason: `garment length wrong: hem at ${pixel.length.hemPos.toFixed(2)} of body height, expected ${pixel.length.expected}`,
      step: "Check the garment's length label; if it's right, ask the seller for a worn or mannequin photo that shows the length.",
    });
  }

  // ---- audit: can block too ----
  if (audit) {
    if (audit.garment_match.verdict === "mismatch") {
      blocks.push({
        reason: `garment doesn't match the seller's photo${audit.garment_match.notes ? ` (${audit.garment_match.notes})` : ""}`,
        step: "Ask the seller for a clearer, front-facing photo of the garment alone.",
      });
    }
    if (audit.person_changes.face_changed || audit.person_changes.hair_changed) {
      const what = [audit.person_changes.face_changed && "face", audit.person_changes.hair_changed && "hair"].filter(Boolean).join(" and ");
      blocks.push({
        reason: `buyer's ${what} changed`,
        // renders are repeatable for the same inputs, so re-rendering won't help
        step: "Ask the buyer for a clear, front-facing photo in good light.",
      });
    }
  }

  if (blocks.length) {
    return {
      card_verdict: "block",
      disclosure_text: null,
      block_reason: blocks.map((b) => b.reason).join("; "),
      next_step: blocks[0].step,
      audit_status: auditStatus,
    };
  }

  // ---- no audit: pixel checks passed, disclose generically ----
  if (!audit) {
    return {
      card_verdict: "send_with_disclosure",
      disclosure_text: `${label} as ordered. Styling, accessories and other garments shown are illustrative.`,
      block_reason: null,
      next_step: null,
      audit_status: auditStatus,
    };
  }

  // ---- audit says something was added: disclose ----
  const pieces = new Set<string>();
  let accessories = false;
  let otherPieces = false;
  for (const it of audit.added_items) {
    if (it.kind === "garment_piece") {
      const name = companionName(garmentLabel, it.item);
      if (name) pieces.add(name);
      else otherPieces = true;
    } else {
      accessories = true;
    }
  }
  const parts = [...pieces];
  if (otherPieces) parts.push("other garments");
  if (accessories) parts.push("accessories");

  if (!parts.length) {
    return { card_verdict: "send", disclosure_text: null, block_reason: null, next_step: null, audit_status: auditStatus };
  }

  const verb = parts.length === 1 && !parts[0].endsWith("s") ? "is" : "are";
  const addedJewellery = audit.added_items.some((i) => i.kind === "jewellery" || i.kind === "accessory");
  return {
    card_verdict: "send_with_disclosure",
    disclosure_text: `${label} as ordered. ${cap(joinList(parts))} ${verb} illustrative.`,
    block_reason: null,
    next_step:
      addedJewellery && framing === "chest"
        ? "Ask the buyer for a full-body photo (chest-up photos get invented jewellery)."
        : pieces.has("blouse")
          ? "Optional: ask the seller to include the blouse in the garment photo."
          : null,
    audit_status: auditStatus,
  };
}
