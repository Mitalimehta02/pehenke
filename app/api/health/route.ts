import { NextResponse } from "next/server";
import { maybePurge } from "@/lib/server/app";

/**
 * Health check and keep-awake ping. Answers immediately without touching the
 * database (Render's health check times out after 5 s), and starts the 30-day
 * retention purge in the background if it hasn't run in the last hour.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.YOUCAM_API_KEY && (process.env.DATABASE_URL || process.env.LOCAL_PGLITE === "1")) void maybePurge();
  return NextResponse.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }, { headers: { "cache-control": "no-store" } });
}
