/**
 * Channel-agnostic message types. Adapters (web chat now, WhatsApp later)
 * turn their input into Incoming and render Outgoing; the engine knows no
 * channel.
 */

export type Incoming = {
  channel: "web" | "whatsapp";
  sellerSlug: string;
  /** web: anonymous cookie id; whatsapp: phone number */
  buyerExternalId: string;
} & (
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "button"; id: string; label?: string }
  /** the chat was opened: greet a new conversation, otherwise do nothing (not recorded) */
  | { kind: "open" }
);

export interface Button {
  id: string;
  label: string;
}

export interface Choice {
  id: string;
  label: string;
  /** blob key of a thumbnail */
  mediaKey?: string;
}

export type Outgoing =
  | { kind: "text"; text: string; buttons?: Button[] }
  | { kind: "image"; mediaKey: string; caption?: string; buttons?: Button[] }
  | { kind: "choices"; text: string; choices: Choice[]; buttons?: Button[] }
  | { kind: "card"; mediaKey: string | null; title: string; lines: string[]; buttons?: Button[] }
  | { kind: "status"; status: "working" | "idle" }
  | { kind: "link"; label: string; href: string };

/** An outgoing (or incoming) message as stored and delivered. */
export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  createdAt: string;
  body: Outgoing | { kind: "in_text"; text: string } | { kind: "in_image"; mediaKey: string };
}

/** Button ids. Parametrised ids carry a target after the colon. */
export const BTN = {
  agree: "consent_yes",
  decline: "consent_no",
  yesFull: "confirm_full", // confirm_full:<photoId>
  retake: "retake",
  sample: "sample", // sample:<photoId>
  garment: "garment", // garment:<garmentId>
  order: "order",
  tryAnother: "try_another",
  newPhoto: "new_photo",
  deletePhotos: "delete_photos",
} as const;

export const param = (id: string) => id.slice(id.indexOf(":") + 1);
export const btn = (base: string, arg?: string) => (arg ? `${base}:${arg}` : base);
