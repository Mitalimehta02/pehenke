import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { STORE_MAX_SIDE, sha256 } from "../storage/blobs";

/**
 * Local development only (YOUCAM_FAKE=1): let the fake renderer return a real
 * render from the spike when one exists for this (garment, person), so local
 * previews look real and cost no units. Matches the uploaded (normalised)
 * bytes back to spike-assets files by re-normalising those files the same way
 * storeImage does.
 */
export async function spikeRenderLookup(): Promise<(src: Uint8Array, ref: Uint8Array) => Promise<Buffer | null>> {
  const root = process.cwd();
  const cachePath = path.join(root, "spike-output", "cache.json");
  if (!existsSync(cachePath)) return async () => null;

  const byHash = new Map<string, string>();
  for (const dir of ["garments", "people"]) {
    const d = path.join(root, "spike-assets", dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /\.(jpe?g|png)$/i.test(x))) {
      const norm = await sharp(readFileSync(path.join(d, f)))
        .rotate()
        .resize(STORE_MAX_SIDE, STORE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      byHash.set(sha256(norm), f);
    }
  }
  type Rec = { status: string; outputPath?: string; job: { kind: string; garmentFile?: string; personFile?: string; category?: string; labelCategory?: string; repeat?: number } };
  const recs = Object.values(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Rec>).filter(
    (r) => r.status === "success" && r.outputPath && r.job.kind === "tryon" && !r.job.repeat && r.job.category === r.job.labelCategory,
  );

  return async (src, ref) => {
    const person = byHash.get(sha256(src));
    const garment = byHash.get(sha256(ref));
    const hit = recs.find((r) => r.job.personFile === person && r.job.garmentFile === garment);
    return hit && existsSync(path.join(root, hit.outputPath!)) ? readFileSync(path.join(root, hit.outputPath!)) : null;
  };
}
