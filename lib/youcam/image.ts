import sharp, { type Sharp } from "sharp";
import { MAX_FILE_BYTES } from "./files";

/** Input limits from each feature's "File Specs & Errors" table. */
export interface ImageSpec {
  formats: Array<"jpeg" | "png">;
  maxLongSide: number;
  minLongSide: number;
  minShortSide: number;
}

export interface PreparedImage {
  bytes: Uint8Array;
  fileName: string;
  contentType: "image/jpg" | "image/png";
  width: number;
  height: number;
  /** what was changed, for logs (e.g. "rotated", "resized 6000->4096", "png->jpeg") */
  changes: string[];
}

export class ImageRejectedError extends Error {
  constructor(fileName: string, reason: string) {
    super(`${fileName}: ${reason}`);
    this.name = "ImageRejectedError";
  }
}

/**
 * Normalises a photo for upload: applies EXIF rotation (phone photos are often
 * stored sideways), strips metadata (GPS etc. never leaves our server),
 * converts unsupported formats, and shrinks oversized images. Rejects images
 * below the feature's minimum size rather than upscaling them.
 */
export async function prepareImage(input: Uint8Array, fileName: string, spec: ImageSpec): Promise<PreparedImage> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height || !meta.format) throw new ImageRejectedError(fileName, "not a readable image");

  const swapped = (meta.orientation ?? 1) >= 5;
  const w = swapped ? meta.height : meta.width;
  const h = swapped ? meta.width : meta.height;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long < spec.minLongSide || short < spec.minShortSide) {
    throw new ImageRejectedError(fileName, `${w}x${h} is below the minimum ${spec.minLongSide}x${spec.minShortSide}`);
  }

  const changes: string[] = [];
  if ((meta.orientation ?? 1) !== 1) changes.push(`rotated (exif ${meta.orientation})`);

  const srcFormat: string = meta.format;
  const target: "jpeg" | "png" = (spec.formats as string[]).includes(srcFormat) ? (srcFormat as "jpeg" | "png") : "jpeg";
  if (target !== srcFormat) changes.push(`${srcFormat}->${target}`);

  let pipeline = sharp(input).rotate();
  if (long > spec.maxLongSide) {
    pipeline = pipeline.resize({ width: spec.maxLongSide, height: spec.maxLongSide, fit: "inside" });
    changes.push(`resized ${long}->${spec.maxLongSide}`);
  }

  let quality = 95;
  let out = await encode(pipeline, target, quality);
  while (out.data.byteLength >= MAX_FILE_BYTES && target === "jpeg" && quality > 60) {
    quality -= 10;
    out = await encode(pipeline, target, quality);
    changes.push(`jpeg q${quality}`);
  }
  if (out.data.byteLength >= MAX_FILE_BYTES) throw new ImageRejectedError(fileName, "still >= 10MB after re-encoding");

  const base = fileName.replace(/\.[^.]+$/, "");
  return {
    bytes: new Uint8Array(out.data),
    fileName: `${base}.${target === "jpeg" ? "jpg" : "png"}`,
    contentType: target === "jpeg" ? "image/jpg" : "image/png",
    width: out.info.width,
    height: out.info.height,
    changes,
  };
}

function encode(p: Sharp, format: "jpeg" | "png", quality: number) {
  const c = p.clone();
  return (format === "jpeg" ? c.jpeg({ quality, mozjpeg: true }) : c.png()).toBuffer({ resolveWithObject: true });
}
