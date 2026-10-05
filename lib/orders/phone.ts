/**
 * Buyer WhatsApp number -> E.164 ("+919876543210"), or null if it doesn't look
 * like a phone number. Indian numbers may be typed without the country code
 * (10 digits starting 6-9, optionally with a leading 0); anything else needs
 * a + or 00 prefix. E.164 allows at most 15 digits.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.trim();
  if (!/^[+\d(][\d\s().-]*$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  const international = raw.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (!international) {
    if (/^0?[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(-10)}`;
    if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
    return null;
  }
  if (digits.startsWith("91") && !/^91[6-9]\d{9}$/.test(digits)) return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** "+91 98765 43210" for display (Indian numbers grouped, others as-is). */
export function formatPhone(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
