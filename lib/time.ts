/** Daily caps and retention use the Asia/Kolkata calendar day (IST, UTC+5:30, no DST). */
const IST_OFFSET_MS = 330 * 60_000;

/** "YYYY-MM-DD" of the IST day containing `at`. */
export function istDay(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant at which the IST day containing `at` starts. */
export function startOfIstDay(at: Date = new Date()): Date {
  return new Date(Date.parse(`${istDay(at)}T00:00:00.000Z`) - IST_OFFSET_MS);
}

export const DAY_MS = 24 * 3600_000;
