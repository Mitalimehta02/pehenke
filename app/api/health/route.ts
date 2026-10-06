import { NextResponse, type NextRequest } from "next/server";
import { maybePurge } from "@/lib/server/app";
import { health } from "@/lib/server/health";

/**
 * Health check and keep-awake ping. Reports "ok" or "degraded" (a required
 * variable missing, the database unreachable, or migrations pending), with
 * names and counts only, never values. Also starts the 30-day retention purge
 * in the background if it hasn't run in the last hour.
 *
 * HTTP status: 503 when a required variable is missing or migrations are
 * pending, so the host does not switch traffic to a deploy that can't work and
 * an uptime monitor raises an alarm. A database that is merely unreachable for
 * a moment (it sleeps when idle) answers 200 with "degraded", so the host does
 * not restart the server over it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const h = await health(req.nextUrl.searchParams.has("fresh"));
  if (h.status === "ok") void maybePurge();
  const { blocking, ...report } = h;
  return NextResponse.json({ ok: h.status === "ok", ...report }, { status: blocking ? 503 : 200, headers: { "cache-control": "no-store" } });
}
