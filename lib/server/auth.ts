import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { Seller } from "../generated/prisma/client";
import { hashKey } from "../sellers/keys";

export { hashKey, newSellerKey } from "../sellers/keys";

/**
 * Web identities.
 * - Buyer: an anonymous random id in an httpOnly cookie (WhatsApp will use the phone number).
 * - Seller: a secret link /seller/<slug>?key=<key>; only sha256(key) is stored. A valid key
 *   is kept in an httpOnly cookie for that seller. The seeded demo seller needs no key.
 */

export const BUYER_COOKIE = "pk_buyer";
const sellerCookie = (slug: string) => `pk_seller_${slug}`;
const YEAR = 365 * 24 * 3600;


/** Read the buyer id, if any (Server Components may only read cookies). */
export async function readBuyerId(): Promise<string | null> {
  return (await cookies()).get(BUYER_COOKIE)?.value ?? null;
}

/** Read or create the buyer id (Route Handlers). */
export async function buyerId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(BUYER_COOKIE)?.value;
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const id = randomBytes(18).toString("base64url");
  jar.set(BUYER_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: YEAR });
  return id;
}

function keyMatches(seller: Pick<Seller, "accessKeyHash">, key: string | null | undefined) {
  if (!key) return false;
  const a = Buffer.from(hashKey(key), "hex");
  const b = Buffer.from(seller.accessKeyHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether this request may act as the seller (demo seller: always). */
export async function isSeller(seller: Pick<Seller, "slug" | "accessKeyHash" | "isDemo">, keyFromUrl?: string | null): Promise<boolean> {
  if (seller.isDemo) return true;
  if (keyMatches(seller, keyFromUrl)) return true;
  return keyMatches(seller, (await cookies()).get(sellerCookie(seller.slug))?.value);
}

/** Remember a valid seller key (Route Handlers / Server Actions only). */
export async function rememberSellerKey(slug: string, key: string) {
  (await cookies()).set(sellerCookie(slug), key, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 24 * 3600 });
}
