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
  reference_leak: z.object({
    /** the garment photo shows a person or a mannequin */
    reference_has_figure: z.boolean(),
    leaked: z.array(
      z.object({
        what: z.enum(["face", "skin_tone", "body_shape", "jewellery", "accessory", "garment"]),
        item: z.string(),
      }),
    ),
  }),
  summary: z.string(),
});

export type RenderAudit = z.infer<typeof renderAuditSchema>;

/** JSON Schema sent to providers that support structured output (kept in sync with the zod schema). */
export const renderAuditJsonSchema = z.toJSONSchema(renderAuditSchema);

// ---------------- garment photo gate ----------------

/** Problems that make a seller's garment photo a poor try-on reference (SPIKE.md). */
export const GARMENT_PHOTO_PROBLEMS = [
  "glass_or_reflection",
  "folded",
  "cropped",
  "holding_object",
  "extra_layers",
  "multiple_garments",
  "too_dark_or_blurry",
  "not_a_garment",
] as const;
export type GarmentPhotoProblem = (typeof GARMENT_PHOTO_PROBLEMS)[number];

export const garmentPhotoAuditSchema = z.object({
  acceptable: z.boolean(),
  problems: z.array(z.enum(GARMENT_PHOTO_PROBLEMS)),
  /** what the photo shows, e.g. "saree draped on a mannequin" */
  seen: z.string(),
});
export type GarmentPhotoAudit = z.infer<typeof garmentPhotoAuditSchema>;
export const garmentPhotoAuditJsonSchema = z.toJSONSchema(garmentPhotoAuditSchema);

export interface GarmentPhotoInput {
  image: AuditImage;
  garmentLabel: string;
  category: string;
  photoType: string;
}

export const GARMENT_GATE_PROMPT = `You are checking a seller's product photo before it is used as the reference
for a virtual try-on of a "{label}" (category: {category}; the seller says it is a {photoType} photo).

A good reference shows the WHOLE garment, front-facing, on a mannequin, a hanger, laid flat, or worn
by a model who holds nothing and wears no extra layers over it, against a plain background.

Report problems (only those clearly present):
- glass_or_reflection: photographed behind glass, or strong reflections/glare on the garment
- folded: the garment is folded, crumpled or bunched so its shape can't be seen
- cropped: part of the garment is cut off by the frame edge
- holding_object: a model holds a bag, phone or other object over or near the garment
- extra_layers: a model or mannequin wears another garment over it (jacket, vest, shawl, a dupatta that is not part of the item)
- multiple_garments: several different garments in the photo, unclear which is for sale
- too_dark_or_blurry: too dark, blurry or low-resolution to see the garment
- not_a_garment: no garment is the subject of the photo
acceptable = true only if there are no problems. "seen" = one short phrase describing the photo.`;

export interface RenderAuditor {
  /** e.g. "gemini:gemini-3.8-flash" */
  readonly name: string;
  auditRender(input: RenderAuditInput): Promise<RenderAudit>;
  /** seller photo gate: is this a usable try-on reference? */
  auditGarmentPhoto(input: GarmentPhotoInput): Promise<GarmentPhotoAudit>;
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
- reference_leak: if image 2 shows a person or a mannequin (reference_has_figure), did anything
  from that figure carry into image 3 instead of staying with the buyer: their face, skin tone,
  body shape, jewellery, accessories (e.g. a bag), or extra garments worn with the item (e.g. a
  vest or jacket over it, leggings under it)? List each leaked thing with what it is. Empty array
  if nothing leaked or if image 2 has no figure.
- summary: one sentence.`;
