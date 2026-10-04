import type { GarmentPhotoProblem, RenderAuditor } from "../audit/types";
import type { Ledger } from "../units/ledger";

/**
 * Seller photo gate: every garment photo is checked ONCE, when the seller adds
 * it. Vision audit when available (and within the daily Gemini budget), plus
 * pixel rules. Without the vision check the photo needs the seller's review
 * (a checklist) before buyers can try it on.
 */

export type GateProblem = GarmentPhotoProblem | "too_small";

export interface GateResult {
  status: "approved" | "rejected" | "needs_review";
  problems: GateProblem[];
  /** "gemini:<model>" | "rules" */
  by: string;
  /** what the vision check saw, if it ran */
  seen?: string;
  /** why the vision check didn't run, if it didn't */
  note?: string;
}

/** YouCam cloth-v3 minimum. */
const MIN_LONG = 512;
const MIN_SHORT = 384;

export class GarmentGate {
  constructor(private readonly d: { auditor?: RenderAuditor; ledger: Ledger }) {}

  async check(p: { bytes: Uint8Array; width: number; height: number; label: string; category: string; photoType: string }): Promise<GateResult> {
    if (Math.max(p.width, p.height) < MIN_LONG || Math.min(p.width, p.height) < MIN_SHORT) {
      return { status: "rejected", problems: ["too_small"], by: "rules" };
    }
    const auditor = this.d.auditor;
    if (!auditor) return { status: "needs_review", problems: [], by: "rules", note: "no vision provider configured" };
    if (!(await this.d.ledger.geminiAvailable())) return { status: "needs_review", problems: [], by: "rules", note: "daily vision-check limit reached" };
    try {
      const a = await auditor.auditGarmentPhoto({ image: { bytes: p.bytes, mimeType: "image/jpeg" }, garmentLabel: p.label, category: p.category, photoType: p.photoType });
      const problems = [...new Set(a.problems)];
      return { status: a.acceptable && !problems.length ? "approved" : "rejected", problems, by: auditor.name, seen: a.seen };
    } catch (err) {
      return { status: "needs_review", problems: [], by: "rules", note: `vision check unavailable: ${(err as Error).message.slice(0, 120)}` };
    }
  }
}
