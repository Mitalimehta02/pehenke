import type { ImageSpec } from "../image";
import type { Feature } from "../types";

/** AI Clothes V3, the latest try-on version (`/s2s/v2.0/{file,task}/cloth-v3`). */
export const CLOTHES_V3: Feature = "cloth-v3";

/**
 * Person and garment photos: jpg/png, 512x384 minimum, long side <= 4096, < 10MB.
 * The docs also want a single, forward-facing, standing person with a fully
 * visible face, and front-facing single-garment product shots. Lower-body
 * references must be worn photos, not product shots.
 */
export const CLOTHES_V3_IMAGE: ImageSpec = {
  formats: ["jpeg", "png"],
  maxLongSide: 4096,
  minLongSide: 512,
  minShortSide: 384,
};
