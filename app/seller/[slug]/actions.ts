"use server";

import { refresh } from "next/cache";
import { resetDemo } from "@/lib/demo/reset";
import type { OrderOutcome } from "@/lib/generated/prisma/client";
import { getApp } from "@/lib/server/app";
import { isSeller } from "@/lib/server/auth";

/** Every action re-checks the seller link (key) before touching anything. */
async function sellerFor(slug: string, key: string | null) {
  const app = await getApp();
  const seller = await app.prisma.seller.findUnique({ where: { slug } });
  if (!seller || !(await isSeller(seller, key))) throw new Error("not allowed");
  return { app, seller };
}

export async function decideOrder(slug: string, key: string | null, orderId: string, decision: "approve" | "reject", note?: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.orders.decide(seller.id, orderId, decision, note);
  refresh();
}

const OUTCOMES: OrderOutcome[] = ["pending", "delivered", "refused", "cancelled"];

export async function setOutcome(slug: string, key: string | null, orderId: string, outcome: OrderOutcome) {
  if (!OUTCOMES.includes(outcome)) throw new Error("bad outcome");
  const { app, seller } = await sellerFor(slug, key);
  await app.orders.setOutcome(seller.id, orderId, outcome);
  refresh();
}

export async function confirmChecklist(slug: string, key: string | null, garmentId: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.garments.confirmChecklist(seller.id, garmentId);
  refresh();
}

export async function setGarmentActive(slug: string, key: string | null, garmentId: string, active: boolean) {
  const { app, seller } = await sellerFor(slug, key);
  await app.garments.setActive(seller.id, garmentId, active);
  refresh();
}

export async function resetDemoData(slug: string, key: string | null) {
  const { app, seller } = await sellerFor(slug, key);
  const r = await resetDemo(app, seller.id);
  refresh();
  return r;
}

export async function markCardSent(slug: string, key: string | null, orderId: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.orders.markCardSent(seller.id, orderId);
  refresh();
}

export async function markDispatched(slug: string, key: string | null, orderId: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.orders.markDispatched(seller.id, orderId);
  refresh();
}

export async function confirmAccessoryCrop(slug: string, key: string | null, accessoryId: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.accessories.confirmCrop(seller.id, accessoryId);
  refresh();
}

export async function setAccessoryActive(slug: string, key: string | null, accessoryId: string, active: boolean) {
  const { app, seller } = await sellerFor(slug, key);
  await app.accessories.setActive(seller.id, accessoryId, active);
  refresh();
}

export async function removeAccessory(slug: string, key: string | null, accessoryId: string) {
  const { app, seller } = await sellerFor(slug, key);
  await app.accessories.remove(seller.id, accessoryId);
  refresh();
}
