import type { ImageSpec } from "../image";
import type { Feature } from "../types";

/** AI Skin Tone Analysis (`/s2s/v2.0/{file,task}/skin-tone-analysis`). */
export const SKIN_TONE: Feature = "skin-tone-analysis";

/**
 * jpg only, long side <= 4096 (auto-resized above 1080 by the server),
 * 100x100 minimum, < 10MB, single person, face wider than 60% of the image.
 */
export const SKIN_TONE_IMAGE: ImageSpec = {
  formats: ["jpeg"],
  maxLongSide: 4096,
  minLongSide: 100,
  minShortSide: 100,
};
