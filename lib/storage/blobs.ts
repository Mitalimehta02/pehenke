import { createHash } from "node:crypto";
import sharp from "sharp";
import { withImageSlot } from "./imageLimit";
import type { PrismaClient } from "../generated/prisma/client";

/**
 * Image storage. Bytes live only here, never in the main tables (which keep
 * the key). Postgres-backed for now; swap the implementation (e.g. R2) without
 * touching callers. Nothing may depend on local disk: Render wipes it.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta: { contentType: string; width: number; height: number }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(keys: string[]): Promise<number>;
  /** total stored bytes */
  totalBytes(): Promise<number>;
}

export class PrismaBlobStore implements BlobStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(key: string, bytes: Uint8Array, meta: { contentType: string; width: number; height: number }) {
    const data = { contentType: meta.contentType, bytes: Buffer.from(bytes), size: bytes.byteLength, width: meta.width, height: meta.height };
    await this.prisma.blob.upsert({ where: { key }, create: { key, ...data }, update: data });
  }

  async get(key: string) {
    const b = await this.prisma.blob.findUnique({ where: { key } });
    return b ? { bytes: new Uint8Array(b.bytes), contentType: b.contentType } : null;
  }

  async delete(keys: string[]) {
    if (!keys.length) return 0;
    return (await this.prisma.blob.deleteMany({ where: { key: { in: keys } } })).count;
  }

  async totalBytes() {
    return (await this.prisma.blob.aggregate({ _sum: { size: true } }))._sum.size ?? 0;
  }
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Longest side kept for stored images; enough for YouCam (recommends 1024x768) and phone screens. */
export const STORE_MAX_SIDE = 1600;

export interface StoredImage {
  key: string;
  /** hash of the stored (normalised) bytes */
  hash: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/**
 * Normalises and stores an image: EXIF rotation applied, metadata (GPS)
 * stripped, resized to STORE_MAX_SIDE, JPEG. The key is derived from the
 * content hash under `prefix`, so storing the same image twice is a no-op.
 */
export async function storeImage(blobs: BlobStore, prefix: string, input: Uint8Array, quality = 85): Promise<StoredImage> {
  const { data, info } = await withImageSlot(() =>
    sharp(input)
      .rotate()
      .resize(STORE_MAX_SIDE, STORE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true }),
  );
  const bytes = new Uint8Array(data);
  const hash = sha256(bytes);
  const key = `${prefix}/${hash.slice(0, 32)}.jpg`;
  await blobs.put(key, bytes, { contentType: "image/jpeg", width: info.width, height: info.height });
  return { key, hash, width: info.width, height: info.height, bytes };
}
