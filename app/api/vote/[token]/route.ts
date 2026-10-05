import { NextResponse, type NextRequest } from "next/server";
import { getApp } from "@/lib/server/app";

/** The one try-on image a family vote link shows; only while the link is open (7 days, not deleted). */
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/vote/[token]">) {
  const { token } = await ctx.params;
  const app = await getApp();
  const vote = await app.family.findOpen(token);
  const blob = vote?.tryOn.outputKey ? await app.blobs.get(vote.tryOn.outputKey) : null;
  if (!blob) return new NextResponse("not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  return new NextResponse(Buffer.from(blob.bytes), {
    headers: { "content-type": blob.contentType, "cache-control": "private, max-age=300", "x-robots-tag": "noindex" },
  });
}
