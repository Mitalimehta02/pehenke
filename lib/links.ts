/**
 * Absolute links the app hands out (seller link, shop chat, per-outfit chat,
 * order card, family vote) and WhatsApp "click to chat" links. Pure: the base
 * URL is passed in (APP_URL on the server).
 *
 * wa.me format (WhatsApp's "click to chat" docs): https://wa.me/<number>?text=<urlencoded>,
 * number in international format with digits only (no +, spaces or leading 0);
 * https://wa.me/?text=<urlencoded> lets the sender pick the contact.
 */

export const DEFAULT_APP_URL = "https://pehenke.onrender.com";

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

export const links = {
  chat: (base: string, slug: string, garmentId?: string) => join(base, `/chat/${slug}${garmentId ? `?g=${encodeURIComponent(garmentId)}` : ""}`),
  seller: (base: string, slug: string, key: string) => join(base, `/seller/${slug}?key=${encodeURIComponent(key)}`),
  card: (base: string, token: string) => join(base, `/card/${token}`),
  cardImage: (base: string, token: string) => join(base, `/api/card/${token}`),
  vote: (base: string, token: string) => join(base, `/v/${token}`),
};

/** wa.me link with prefilled text; to a number (E.164) or, without one, to a contact the sender picks. */
export function waLink(text: string, toE164?: string | null): string {
  const to = toE164 ? toE164.replace(/\D/g, "") : "";
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
