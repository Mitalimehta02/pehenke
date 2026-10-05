import { NextResponse, type NextRequest } from "next/server";
import { DuplicatePhotoError } from "@/lib/garments/service";
import type { Category, GarmentLength, PhotoType } from "@/lib/generated/prisma/client";
import { MAX_UPLOAD_BYTES } from "@/lib/photos/buyerPhoto";
import { getApp } from "@/lib/server/app";
import { isSeller } from "@/lib/server/auth";

/** Add a garment (multipart; route handler because photos exceed the 1 MB server-action limit). Runs the photo gate once. */
export const runtime = "nodejs";

const CATEGORIES: Category[] = ["upper_body", "full_body"];
const PHOTO_TYPES: PhotoType[] = ["flatlay", "hanger", "mannequin", "worn"];
const LENGTHS: GarmentLength[] = ["crop", "waist", "hip", "knee", "ankle", "floor"];

export async function POST(req: NextRequest, ctx: RouteContext<"/api/seller/[slug]/garments">) {
  const { slug } = await ctx.params;
  const form = await req.formData();
  const app = await getApp();
  const seller = await app.prisma.seller.findUnique({ where: { slug } });
  if (!seller || !(await isSeller(seller, String(form.get("key") ?? "") || null))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  const file = form.get("photo");
  const label = String(form.get("label") ?? "").trim().slice(0, 80);
  const category = String(form.get("category")) as Category;
  const photoType = String(form.get("photoType")) as PhotoType;
  const length = String(form.get("length") ?? "") as GarmentLength | "";
  const price = Number(String(form.get("priceInr") ?? "").replace(/[^\d]/g, ""));
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Please add a photo." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  if (!label) return NextResponse.json({ error: "Please give the item a name." }, { status: 400 });
  if (!CATEGORIES.includes(category) || !PHOTO_TYPES.includes(photoType)) return NextResponse.json({ error: "Please choose the options." }, { status: 400 });

  try {
    const g = await app.garments.add(seller.id, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      label,
      category,
      photoType,
      length: LENGTHS.includes(length as GarmentLength) ? (length as GarmentLength) : null,
      priceInr: price > 0 ? price : null,
      includesBlouse: form.get("includesBlouse") === "on",
      notes: String(form.get("notes") ?? "").slice(0, 300),
    });
    return NextResponse.json({ id: g.id, gateStatus: g.gateStatus, gateAdvice: g.gateAdvice });
  } catch (err) {
    if (err instanceof DuplicatePhotoError) return NextResponse.json({ error: `You already added this photo (${err.message}).` }, { status: 409 });
    console.error("[seller] add garment failed", err);
    return NextResponse.json({ error: "Couldn't add the item. Please try again." }, { status: 500 });
  }
}
