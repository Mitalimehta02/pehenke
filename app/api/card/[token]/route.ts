import { NextResponse, type NextRequest } from "next/server";
import { getApp } from "@/lib/server/app";

/**
 * The order card image, public by its unguessable token (the seller sends the
 * link to the buyer on WhatsApp). Stops working when the buyer deletes their
 * photos (the token is cleared). ?download=1 saves it as a file.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/card/[token]">) {
  const { token } = await ctx.params;
  const app = await getApp();
  const order = await app.orders.cardByToken(token);
  const key = order ? await app.orders.ensureCardImage(order.id) : null;
  const blob = key ? await app.blobs.get(key) : null;
  if (!order || !blob) return new NextResponse("not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  const headers: Record<string, string> = {
    "content-type": blob.contentType,
    "cache-control": "private, max-age=300",
    "x-robots-tag": "noindex",
  };
  if (req.nextUrl.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="order-${order.id.slice(-6).toUpperCase()}.jpg"`;
  return new NextResponse(Buffer.from(blob.bytes), { headers });
}
