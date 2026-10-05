import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Secret keys and tokens. Plain (no Next imports) so scripts and tests share them. */

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newSellerKey = () => randomBytes(18).toString("base64url");
/** Unguessable token for public links (order card, family vote): 128 bits. */
export const newToken = () => randomBytes(16).toString("base64url");

/** Constant-time comparison of two secrets (compares their hashes, so lengths may differ). */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(Buffer.from(hashKey(a), "hex"), Buffer.from(hashKey(b), "hex"));
}
