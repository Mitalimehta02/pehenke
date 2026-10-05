import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { links } from "../links";
import { hashKey, newSellerKey } from "./keys";

/**
 * Real seller onboarding (admin page and `npm run seller:create`). The secret
 * seller key is returned once and only its hash is stored: if it's lost,
 * issue a new link (which stops the old one working).
 */

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export class OnboardError extends Error {}

/** "Meera's Boutique, Jaipur" -> "meeras-boutique-jaipur". Empty for names with no Latin letters or digits. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export interface SellerLinks {
  /** private: the seller's own page; anyone with it can act as the seller */
  sellerUrl: string;
  /** public: the shop's buyer chat, to share with buyers */
  chatUrl: string;
}

export interface CreatedSeller extends SellerLinks {
  id: string;
  slug: string;
  name: string;
}

export async function createSeller(prisma: PrismaClient, baseUrl: string, input: { name: string; slug?: string }): Promise<CreatedSeller> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) throw new OnboardError("Shop name must be 2 to 60 characters.");

  let slug: string;
  if (input.slug?.trim()) {
    slug = input.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new OnboardError("Link name: 3 to 40 characters, lowercase letters, digits and hyphens.");
    if (await prisma.seller.findUnique({ where: { slug } })) throw new OnboardError(`The link name "${slug}" is taken.`);
  } else {
    slug = await freeSlug(prisma, slugify(name));
  }

  const key = newSellerKey();
  const seller = await prisma.seller.create({ data: { slug, name, accessKeyHash: hashKey(key), isDemo: false } });
  return { id: seller.id, slug, name, sellerUrl: links.seller(baseUrl, slug, key), chatUrl: links.chat(baseUrl, slug) };
}

/** New secret seller link; the old one stops working. Not for the demo seller (it needs no key). */
export async function rotateSellerKey(prisma: PrismaClient, baseUrl: string, sellerId: string): Promise<CreatedSeller> {
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  if (seller.isDemo) throw new OnboardError("The demo shop has no secret link.");
  const key = newSellerKey();
  await prisma.seller.update({ where: { id: sellerId }, data: { accessKeyHash: hashKey(key) } });
  return { id: seller.id, slug: seller.slug, name: seller.name, sellerUrl: links.seller(baseUrl, seller.slug, key), chatUrl: links.chat(baseUrl, seller.slug) };
}

async function freeSlug(prisma: PrismaClient, base: string): Promise<string> {
  const stem = base.length >= 3 ? base.slice(0, 34).replace(/-+$/g, "") : `shop-${randomBytes(3).toString("hex")}`;
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? stem : `${stem}-${i}`;
    if (!(await prisma.seller.findUnique({ where: { slug } }))) return slug;
  }
  return `${stem}-${randomBytes(3).toString("hex")}`;
}
