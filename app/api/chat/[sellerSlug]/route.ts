import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError } from "@/lib/engine/engine";
import type { Incoming } from "@/lib/engine/types";
import { MAX_UPLOAD_BYTES } from "@/lib/photos/buyerPhoto";
import { getApp } from "@/lib/server/app";
import { buyerId } from "@/lib/server/auth";

/**
 * Web chat adapter: the only bridge between the web UI and the engine.
 * GET  -> conversation history + state
 * POST -> one incoming message (multipart: kind=text|button|image|open)
 */

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/chat/[sellerSlug]">) {
  const { sellerSlug } = await ctx.params;
  const app = await getApp();
  const conv = await app.engine.findConversation(sellerSlug, "web", await buyerId());
  if (!conv) return NextResponse.json({ messages: [], state: "NEW" });
  return NextResponse.json({ messages: await app.engine.messagesSince(conv.id), state: conv.state });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/chat/[sellerSlug]">) {
  const { sellerSlug } = await ctx.params;
  const form = await req.formData();
  const kind = String(form.get("kind") ?? "");
  const base = { channel: "web" as const, sellerSlug, buyerExternalId: await buyerId() };

  let incoming: Incoming;
  if (kind === "text") {
    const text = String(form.get("text") ?? "").slice(0, 2000);
    if (!text.trim()) return NextResponse.json({ error: "empty message" }, { status: 400 });
    incoming = { ...base, kind, text };
  } else if (kind === "button") {
    incoming = { ...base, kind, id: String(form.get("id") ?? ""), label: String(form.get("label") ?? "") || undefined };
  } else if (kind === "image") {
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });
    incoming = { ...base, kind, bytes: new Uint8Array(await file.arrayBuffer()) };
  } else if (kind === "open") {
    incoming = { ...base, kind };
  } else {
    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  }

  try {
    const app = await getApp();
    const r = await app.engine.handle(incoming);
    const conv = await app.engine.findConversation(sellerSlug, "web", base.buyerExternalId);
    return NextResponse.json({ messages: r.messages, state: conv?.state ?? "NEW" });
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: "shop not found" }, { status: 404 });
    console.error("[chat] handle failed", err);
    return NextResponse.json({ error: "something went wrong" }, { status: 500 });
  }
}
