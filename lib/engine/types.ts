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
  /**
   * the chat was opened: greet a new conversation, otherwise do nothing (not recorded).
   * garmentId: opened from a shared outfit link, so that outfit is preselected.
   */
  | { kind: "open"; garmentId?: string }
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
  askFamily: "ask_family",
  skipPhone: "skip_phone",
  completeLook: "look",
  neckYes: "neck_yes",
  neckNo: "neck_no",
  lookEarring: "look_earring", // look_earring:<accessoryId|none>
  lookNecklace: "look_necklace", // look_necklace:<accessoryId|none>
  lookLip: "look_lip", // look_lip:<0|1|none>
  lookShow: "look_show",
  lookRestart: "look_restart",
  lookBack: "look_back",
  orderLook: "order_look",
  addUnshown: "add_unshown", // add_unshown:<accessoryId>: order an item that could not be shown in the picture
} as const;

export const param = (id: string) => id.slice(id.indexOf(":") + 1);
export const btn = (base: string, arg?: string) => (arg ? `${base}:${arg}` : base);
