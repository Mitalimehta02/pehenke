import { NextResponse, type NextRequest } from "next/server";
import { DuplicateAccessoryError } from "@/lib/accessories/service";
import type { AccessoryType } from "@/lib/generated/prisma/client";
import { MAX_UPLOAD_BYTES } from "@/lib/photos/buyerPhoto";
import { getApp } from "@/lib/server/app";
import { isSeller } from "@/lib/server/auth";

/** Add jewellery for "complete the look" (multipart; photos exceed the 1 MB server-action limit). Runs the photo gate once. */
export const runtime = "nodejs";

const TYPES: AccessoryType[] = ["earring", "necklace"];

export async function POST(req: NextRequest, ctx: RouteContext<"/api/seller/[slug]/accessories">) {
  const { slug } = await ctx.params;
  const form = await req.formData();
  const app = await getApp();
  const seller = await app.prisma.seller.findUnique({ where: { slug } });
  if (!seller || !(await isSeller(seller, String(form.get("key") ?? "") || null))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  const file = form.get("photo");
  const label = String(form.get("label") ?? "").trim().slice(0, 80);
  const type = String(form.get("type")) as AccessoryType;
  const price = Number(String(form.get("priceInr") ?? "").replace(/[^\d]/g, ""));
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Please add a photo." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  if (!label) return NextResponse.json({ error: "Please give the item a name." }, { status: 400 });
  if (!TYPES.includes(type)) return NextResponse.json({ error: "Please choose earrings or necklace." }, { status: 400 });

  try {
    const a = await app.accessories.add(seller.id, { bytes: new Uint8Array(await file.arrayBuffer()), type, label, priceInr: price > 0 ? price : null });
    return NextResponse.json({ id: a.id, gateStatus: a.gateStatus, gateAdvice: a.gateAdvice });
  } catch (err) {
    if (err instanceof DuplicateAccessoryError) return NextResponse.json({ error: `You already added this photo (${err.message}).` }, { status: 409 });
    console.error("[seller] add accessory failed", err);
    return NextResponse.json({ error: "Couldn't add the item. Please try again." }, { status: 500 });
  }
}
