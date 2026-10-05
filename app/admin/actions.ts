"use server";

import { refresh } from "next/cache";
import { getApp } from "@/lib/server/app";
import { adminLogin, adminLogout, isAdmin } from "@/lib/server/admin";
import { createSeller, OnboardError, rotateSellerKey, type CreatedSeller } from "@/lib/sellers/onboard";

export type AdminResult = { ok: true; seller: CreatedSeller } | { ok: false; error: string };

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
  const r = await adminLogin(String(form.get("secret") ?? ""));
  if (r === "ok") {
    refresh();
    return null;
  }
  return r === "throttled" ? "Too many wrong attempts. Try again in 15 minutes." : "That's not the admin secret.";
}

export async function logout() {
  await adminLogout();
  refresh();
}

/** Every action re-checks the admin cookie. The seller link (with its key) is returned once, to the admin only. */
export async function addSeller(name: string, slug: string): Promise<AdminResult> {
  if (!(await isAdmin())) return { ok: false, error: "Not signed in." };
  const app = await getApp();
  try {
    const seller = await createSeller(app.prisma, app.baseUrl, { name, slug: slug || undefined });
    refresh();
    return { ok: true, seller };
  } catch (err) {
    if (err instanceof OnboardError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function newSellerLink(sellerId: string): Promise<AdminResult> {
  if (!(await isAdmin())) return { ok: false, error: "Not signed in." };
  const app = await getApp();
  try {
    return { ok: true, seller: await rotateSellerKey(app.prisma, app.baseUrl, sellerId) };
  } catch (err) {
    if (err instanceof OnboardError) return { ok: false, error: err.message };
    throw err;
  }
}
