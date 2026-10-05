"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { VoteClosedError } from "@/lib/family/service";
import { getApp } from "@/lib/server/app";
import { VOTER_COOKIE } from "./voter";

/** One (changeable) vote per browser: a random id in an httpOnly cookie, stored only as a per-link hash. */
export async function castVote(token: string, likes: boolean, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const jar = await cookies();
  let voter = jar.get(VOTER_COOKIE)?.value;
  if (!voter || !/^[A-Za-z0-9_-]{16,64}$/.test(voter)) {
    voter = randomBytes(18).toString("base64url");
    jar.set(VOTER_COOKIE, voter, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/v", maxAge: 30 * 24 * 3600 });
  }
  try {
    await (await getApp()).family.cast(token, voter, likes, name);
    return { ok: true };
  } catch (err) {
    if (err instanceof VoteClosedError) return { ok: false, error: "This link has expired, so votes are closed." };
    throw err;
  }
}
