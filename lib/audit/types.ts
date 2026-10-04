import { z } from "zod";

/**
 * Render audit: a vision model compares the person photo, the garment photo
 * and the try-on output, and reports what it sees. It does not decide: the
 * card verdict is made in lib/verdict from these facts plus pixel checks.
 * Providers implement RenderAuditor; the pipeline only sees this module.
 */

export interface AuditImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

export interface RenderAuditInput {
  person: AuditImage;
  garment: AuditImage;
  output: AuditImage;
  /** seller's label, e.g. "saree", "choli" */
  garmentLabel: string;
  /** e.g. "upper_body", "full_body" */
  category: string;
}

const LENGTH = z.enum(["crop", "waist", "hip", "knee", "ankle", "floor", "unclear"]);

export const renderAuditSchema = z.object({
  garment_match: z.object({
    verdict: z.enum(["match", "partial", "mismatch"]),
    notes: z.string(),
  }),
  length: z.object({
    reference: LENGTH,
    output: LENGTH,
    matches: z.boolean(),
  }),
  added_items: z.array(
    z.object({
      item: z.string(),
      kind: z.enum(["jewellery", "accessory", "garment_piece", "other"]),
      location: z.string(),
    }),
  ),
  person_changes: z.object({
    face_changed: z.boolean(),
    hair_changed: z.boolean(),
    background_changed: z.boolean(),
    notes: z.string(),
  }),
  drape: z.enum(["natural", "pasted_on", "not_applicable"]),
  summary: z.string(),
});

export type RenderAudit = z.infer<typeof renderAuditSchema>;

/** JSON Schema sent to providers that support structured output (kept in sync with the zod schema). */
export const renderAuditJsonSchema = z.toJSONSchema(renderAuditSchema);

export interface RenderAuditor {
  /** e.g. "gemini:gemini-3.8-flash" */
  readonly name: string;
  auditRender(input: RenderAuditInput): Promise<RenderAudit>;
}

export const AUDIT_PROMPT = `You are checking a virtual try-on render for an Indian clothing seller.
It will be sent to the buyer as their order confirmation ("this is what you ordered, on you"),
so anything in it that the buyer did not order is a problem.

Image 1 is the buyer's original photo. Image 2 is the seller's garment photo (the reference).
Image 3 is the try-on output: the buyer from image 1 wearing the garment from image 2.
The garment is a "{label}" (category: {category}).

Compare carefully and report:
- garment_match: does the garment in image 3 match image 2 in colour, pattern and construction?
- length: where the garment ends on the body in image 2 (if it can be judged; otherwise "unclear")
  and in image 3. matches=false when the output is clearly longer or shorter than the reference.
- added_items: anything in image 3 that is in neither image 1 nor image 2: jewellery (necklaces,
  earrings, bangles), accessories (bags, belts, glasses), or garment pieces the model invented
  (e.g. a blouse, dupatta or underlayer not shown in the reference). Do not list the garment itself.
  Do not list items that were already in image 1. Empty array if none.
- person_changes: did the face, hair or background change between image 1 and image 3?
- drape: for sarees and dupattas, does the fabric look naturally draped ("natural") or flatly
  pasted onto the body ("pasted_on")? Otherwise "not_applicable".
- summary: one sentence.`;
