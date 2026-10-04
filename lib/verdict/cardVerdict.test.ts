import { describe, expect, it } from "vitest";
import type { RenderAudit } from "../audit/types";
import { decideCardVerdict, type VerdictInput } from "./cardVerdict";

const clean: RenderAudit = {
  garment_match: { verdict: "match", notes: "" },
  length: { reference: "floor", output: "floor", matches: true },
  added_items: [],
  person_changes: { face_changed: false, hair_changed: false, background_changed: false, notes: "" },
  drape: "natural",
  summary: "",
};

const audit = (patch: Partial<RenderAudit>): RenderAudit => ({ ...clean, ...patch });

function input(patch: Partial<VerdictInput> = {}): VerdictInput {
  return {
    garmentLabel: "saree",
    framing: "full",
    audit: clean,
    auditStatus: "ok",
    pixel: { regionUnchanged: false, length: { flagged: false, expected: "floor", hemPos: 0.9 } },
    ...patch,
  };
}

describe("decideCardVerdict", () => {
  it("sends a clean render", () => {
    expect(decideCardVerdict(input())).toMatchObject({ card_verdict: "send", disclosure_text: null, block_reason: null });
  });

  it("discloses an invented blouse on a saree", () => {
    const r = decideCardVerdict(input({ audit: audit({ added_items: [{ item: "cream blouse", kind: "garment_piece", location: "upper body" }] }) }));
    expect(r.card_verdict).toBe("send_with_disclosure");
    expect(r.disclosure_text).toBe("Saree as ordered. Blouse is illustrative.");
  });

  it("discloses blouse + necklace with the agreed wording, and suggests a full-body photo for chest-up input", () => {
    const r = decideCardVerdict(
      input({
        framing: "chest",
        pixel: { regionUnchanged: false },
        audit: audit({
          added_items: [
            { item: "pearl necklace", kind: "jewellery", location: "neck" },
            { item: "purple blouse", kind: "garment_piece", location: "torso" },
          ],
        }),
      }),
    );
    expect(r.card_verdict).toBe("send_with_disclosure");
    expect(r.disclosure_text).toBe("Saree as ordered. Blouse and accessories are illustrative.");
    expect(r.next_step).toMatch(/full-body photo/);
  });

  it("discloses invented leggings on a kurti", () => {
    const r = decideCardVerdict(input({ garmentLabel: "kurti", audit: audit({ added_items: [{ item: "white leggings", kind: "garment_piece", location: "legs" }] }) }));
    expect(r.disclosure_text).toBe("Kurti as ordered. Bottoms are illustrative.");
  });

  it("blocks when the pixel length check flags, even if the audit is clean", () => {
    const r = decideCardVerdict(input({ garmentLabel: "choli", pixel: { regionUnchanged: false, length: { flagged: true, expected: "crop", hemPos: 0.52 } } }));
    expect(r.card_verdict).toBe("block");
    expect(r.block_reason).toMatch(/length wrong.*0\.52.*crop/);
    expect(r.next_step).toMatch(/length label/);
  });

  it("blocks when the clothing region is unchanged", () => {
    expect(decideCardVerdict(input({ pixel: { regionUnchanged: true } })).card_verdict).toBe("block");
  });

  it("blocks a garment mismatch", () => {
    const r = decideCardVerdict(input({ audit: audit({ garment_match: { verdict: "mismatch", notes: "different colour" } }) }));
    expect(r.card_verdict).toBe("block");
    expect(r.block_reason).toMatch(/different colour/);
  });

  it("does not block a partial match", () => {
    expect(decideCardVerdict(input({ audit: audit({ garment_match: { verdict: "partial", notes: "" } }) })).card_verdict).toBe("send");
  });

  it("blocks when face or hair changed, listing every reason", () => {
    const r = decideCardVerdict(
      input({
        pixel: { regionUnchanged: true },
        audit: audit({ person_changes: { face_changed: true, hair_changed: true, background_changed: false, notes: "" } }),
      }),
    );
    expect(r.card_verdict).toBe("block");
    expect(r.block_reason).toMatch(/unchanged.*face and hair changed/);
  });

  it("falls back to pixel checks with a generic disclosure when the audit is unavailable", () => {
    const r = decideCardVerdict(input({ audit: undefined, auditStatus: "unavailable" }));
    expect(r).toMatchObject({ card_verdict: "send_with_disclosure", audit_status: "unavailable" });
    expect(r.disclosure_text).toBe("Saree as ordered. Styling, accessories and other garments shown are illustrative.");
  });

  it("still blocks on pixel checks without an audit", () => {
    const r = decideCardVerdict(input({ audit: undefined, auditStatus: "not_configured", pixel: { regionUnchanged: true } }));
    expect(r).toMatchObject({ card_verdict: "block", audit_status: "not_configured" });
  });
});
