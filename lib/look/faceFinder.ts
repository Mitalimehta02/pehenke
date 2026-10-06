import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { withImageSlot } from "../storage/imageLimit";

/**
 * Free, local face locator: a TypeScript port of picojs (pixel-intensity
 * comparison cascade, MIT, https://github.com/nenadmarkus/picojs) with its
 * frontal-face cascade in assets/models/facefinder.bin. No API call, about
 * 0.2 s per photo. Used to find the head-and-shoulders crop of a try-on
 * (the look features reject a full-body image: SPIKE.md).
 */

export interface Face {
  /** centre and size (square side) as fractions of the image width / height */
  cx: number;
  cy: number;
  /** side of the face square as a fraction of the image WIDTH */
  size: number;
  score: number;
}

export type FaceFinder = (bytes: Uint8Array) => Promise<Face[]>;

type Classifier = (r: number, c: number, s: number, pixels: Uint8Array, ldim: number) => number;

/** Detection runs on a copy at most this many pixels on the long side. */
const MAX_SIDE = 640;
/** Cluster scores below this are noise (clear frontal faces score 30-250 here). */
const MIN_SCORE = 8;

let classifier: Classifier | undefined;

function unpackCascade(bytes: Uint8Array): Classifier {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // first 8 bytes: version and training data; then tree depth and tree count (int32 LE)
  let p = 8;
  const depth = view.getInt32(p, true);
  p += 4;
  const ntrees = view.getInt32(p, true);
  p += 4;
  const leaves = 1 << depth;
  const tcodes = new Int8Array(ntrees * 4 * leaves);
  const tpreds = new Float32Array(ntrees * leaves);
  const thresh = new Float32Array(ntrees);
  for (let t = 0; t < ntrees; t++) {
    // binary tests of the internal nodes (the first 4 slots of each tree are unused)
    for (let i = 0; i < 4 * leaves - 4; i++) tcodes[t * 4 * leaves + 4 + i] = view.getInt8(p + i);
    p += 4 * leaves - 4;
    for (let i = 0; i < leaves; i++, p += 4) tpreds[t * leaves + i] = view.getFloat32(p, true);
    thresh[t] = view.getFloat32(p, true);
    p += 4;
  }
  return (r, c, s, pixels, ldim) => {
    r *= 256;
    c *= 256;
    let root = 0;
    let o = 0;
    for (let i = 0; i < ntrees; i++) {
      let idx = 1;
      for (let j = 0; j < depth; j++) {
        const a = pixels[((r + tcodes[root + 4 * idx] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)];
        const b = pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)];
        idx = 2 * idx + (a <= b ? 1 : 0);
      }
      o += tpreds[leaves * i + idx - leaves];
      if (o <= thresh[i]) return -1;
      root += 4 * leaves;
    }
    return o - thresh[ntrees - 1];
  };
}

type Det = [r: number, c: number, s: number, q: number];

function iou(a: Det, b: Det) {
  const overR = Math.max(0, Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2));
  const overC = Math.max(0, Math.min(a[1] + a[2] / 2, b[1] + b[2] / 2) - Math.max(a[1] - a[2] / 2, b[1] - b[2] / 2));
  return (overR * overC) / (a[2] * a[2] + b[2] * b[2] - overR * overC);
}

/** Faces in a greyscale image, strongest first. Exported for tests. */
export function detectInGrey(pixels: Uint8Array, width: number, height: number, classify: Classifier): Det[] {
  const dets: Det[] = [];
  const maxSize = Math.min(width, height);
  for (let scale = 24; scale <= maxSize; scale *= 1.1) {
    const step = Math.max(0.1 * scale, 1) >> 0;
    const offset = (scale / 2 + 1) >> 0;
    for (let r = offset; r <= height - offset; r += step) {
      for (let c = offset; c <= width - offset; c += step) {
        const q = classify(r, c, scale, pixels, width);
        if (q > 0) dets.push([r, c, scale, q]);
      }
    }
  }
  // non-maximum suppression: overlapping detections merge, scores add up
  dets.sort((a, b) => b[3] - a[3]);
  const used = new Array<boolean>(dets.length).fill(false);
  const clusters: Det[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (used[i]) continue;
    let r = 0, c = 0, s = 0, q = 0, n = 0;
    for (let j = i; j < dets.length; j++) {
      if (!used[j] && iou(dets[i], dets[j]) > 0.2) {
        used[j] = true;
        r += dets[j][0];
        c += dets[j][1];
        s += dets[j][2];
        q += dets[j][3];
        n++;
      }
    }
    clusters.push([r / n, c / n, s / n, q]);
  }
  return clusters.filter((d) => d[3] >= MIN_SCORE).sort((a, b) => b[3] - a[3]);
}

/** Frontal faces in a photo, strongest first (empty if none). */
export const findFaces: FaceFinder = async (bytes) => {
  classifier ??= unpackCascade(new Uint8Array(readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "assets", "models", "facefinder.bin"))));
  const { data, info } = await withImageSlot(() =>
    sharp(bytes).rotate().removeAlpha().resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true }),
  );
  return detectInGrey(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, classifier).map(([r, c, s, q]) => ({
    cx: c / info.width,
    cy: r / info.height,
    size: s / info.width,
    score: Math.round(q),
  }));
};

/**
 * The one face a look can be built on, or why not. A second detection only
 * counts as another person when it is strong and of comparable size (weak
 * extras are usually patterns in the background or the fabric).
 */
export function pickFace(faces: Face[]): { face: Face } | { problem: "no_face" | "several_faces" } {
  if (!faces.length) return { problem: "no_face" };
  const [first, ...rest] = faces;
  if (rest.some((f) => f.score > 0.5 * first.score && f.size > 0.5 * first.size)) return { problem: "several_faces" };
  return { face: first };
}
