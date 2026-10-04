import { NextResponse, type NextRequest } from "next/server";
import { getApp } from "@/lib/server/app";
import { buyerId } from "@/lib/server/auth";

/** Polling: messages after ?after=<messageId>, plus the conversation state (for the typing indicator). */
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/chat/[sellerSlug]/events">) {
  const { sellerSlug } = await ctx.params;
  const app = getApp();
  const conv = await app.engine.findConversation(sellerSlug, "web", await buyerId());
  if (!conv) return NextResponse.json({ messages: [], state: "NEW" });
  const after = req.nextUrl.searchParams.get("after") ?? undefined;
  return NextResponse.json({ messages: await app.engine.messagesSince(conv.id, after), state: conv.state });
}
