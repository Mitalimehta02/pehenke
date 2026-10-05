import "server-only";
import { cookies } from "next/headers";
import { serverEnv } from "../env";
import { hashKey, secretsMatch } from "../sellers/keys";

/**
 * /admin access: one shared secret (ADMIN_SECRET). /admin doesn't exist while
 * it's unset. After a correct secret, an httpOnly cookie holds a hash of it
 * (never the secret itself) for 12 hours. Failed attempts are throttled.
 */

const COOKIE = "pk_admin";
const MAX_AGE = 12 * 3600;
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const failures: number[] = [];

const cookieValue = (secret: string) => hashKey(`pehenke-admin:${secret}`);

export function adminEnabled(): boolean {
  return !!serverEnv().ADMIN_SECRET;
}

export async function isAdmin(): Promise<boolean> {
  const secret = serverEnv().ADMIN_SECRET;
  if (!secret) return false;
  return secretsMatch((await cookies()).get(COOKIE)?.value, cookieValue(secret));
}

/** Server Actions only (sets a cookie). */
export async function adminLogin(input: string): Promise<"ok" | "wrong" | "throttled" | "disabled"> {
  const secret = serverEnv().ADMIN_SECRET;
  if (!secret) return "disabled";
  const now = Date.now();
  while (failures.length && failures[0] < now - WINDOW_MS) failures.shift();
  if (failures.length >= MAX_FAILURES) return "throttled";
  if (!secretsMatch(input, secret)) {
    failures.push(now);
    return "wrong";
  }
  (await cookies()).set(COOKIE, cookieValue(secret), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/admin", maxAge: MAX_AGE });
  return "ok";
}

export async function adminLogout() {
  (await cookies()).delete({ name: COOKIE, path: "/admin" });
}
