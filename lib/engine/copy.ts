/**
 * Every buyer- and seller-facing string. English only for now; keep all text
 * here so a Hindi table can be added later without touching the engine.
 */
import type { DeletionSummary } from "../consent/service";
import { RETENTION_DAYS } from "../consent/service";
import { VOTE_DAYS } from "../family/limits";
import type { Tally } from "../family/service";
import type { PhotoRejection } from "../photos/buyerPhoto";

const inr = (n: number | null | undefined) => (n == null ? "" : ` · ₹${n.toLocaleString("en-IN")}`);

export const copy = {
  buttons: {
    agree: "I agree",
    decline: "No thanks",
    yesFull: "Yes, head to toe",
    retake: "No, I'll retake",
    order: "Order this",
    tryAnother: "Try another",
    newPhoto: "Use a different photo",
    deletePhotos: "Delete my photos",
    askFamily: "Ask family",
    skipPhone: "Skip",
    completeLook: "Complete the look",
    neckYes: "Yes, it's bare",
    neckNo: "No, there's jewellery",
    noEarrings: "No earrings",
    noNecklace: "No necklace",
    noLip: "No lip colour",
    showMe: "Show me",
    lookRestart: "Start again",
    lookBack: "Back to my preview",
    orderLook: "Order this look",
    orderOutfitOnly: "Order outfit only",
    changeLook: "Change the look",
  },

  greeting: (seller: string) => `Hi! Welcome to ${seller}. See any of our outfits on you before you order. 👗`,
  /** opened from a shared outfit link */
  wantGarment: (label: string, priceInr: number | null) => `You asked about: ${label}${inr(priceInr)}. Send your photo and I'll show it on you.`,
  offerGarment: (label: string) => `You opened the link for ${label}. Tap it to see it on you:`,

  consent: () =>
    [
      "Before you send a photo:",
      "• To show you wearing an outfit, we send your photo to our try-on provider (YouCam).",
      `• Your photos and try-on images are deleted automatically after ${RETENTION_DAYS} days.`,
      "• Type \"delete my photos\" any time to delete them sooner.",
      "• If you order, your confirmation card (with your try-on image) gets a private link the shop can send to your WhatsApp.",
      `• Sharing is your choice: "Ask family" makes a link that shows one try-on image to anyone you send it to, for ${VOTE_DAYS} days.`,
      "Do you agree?",
    ].join("\n"),

  consentReminder: () => "Please tap \"I agree\" to continue, or \"No thanks\".",
  declined: () => "No problem. Nothing was saved. Say \"hi\" any time if you change your mind.",

  askPhoto: (hasSamples: boolean) =>
    [
      "Please send a photo of yourself:",
      "• full body, head to toe",
      "• standing, facing the camera",
      "• good light, nothing in your hands",
      hasSamples ? "Or try it first with a sample photo:" : "",
    ]
      .filter(Boolean)
      .join("\n"),

  photoRejected: (reason: PhotoRejection) =>
    ({
      not_an_image: "That doesn't look like a photo. Please send a picture of yourself, head to toe.",
      too_large: "That photo is too large. Please send a smaller one (most phone photos are fine).",
      too_small: "That photo is too small for a good preview. Please send a clearer, larger photo, head to toe.",
      landscape: "Please send an upright (portrait) photo of yourself standing, head to toe. Sideways photos don't work.",
    })[reason],

  confirmFullBody: () => "Thanks! Is this a full-body photo, from your head to your feet?",
  retake: () => "Okay. Please send a new photo: standing, facing the camera, head to toe.",
  photoReminder: () => "Please send a photo (head to toe), or pick a sample photo.",

  pickGarment: (count: number) => (count ? "Which outfit would you like to see on you?" : "This shop has no outfits ready to try yet. Please check back soon."),
  garmentChoice: (label: string, priceInr: number | null) => `${label}${inr(priceInr)}`,

  working: () => "Working on it… this takes about 20 seconds. ⏳",
  stillWorking: () => "Still working on your preview, almost there…",

  preview: (disclosure: string | null) => ["Here's how it looks on you!", disclosure ?? ""].filter(Boolean).join("\n"),
  previewBlocked: () => "Sorry, I couldn't make a good preview of this one. Please try another outfit or a different photo. You won't be charged anything.",
  renderFailed: (error: string | null) =>
    /no_face|pose|face_parsing|shoulder|multiple_people/.test(error ?? "")
      ? "I couldn't see you clearly in that photo. Please send a new one: one person, standing, facing the camera, head to toe."
      : "Something went wrong making your preview. Please try again, or pick another outfit.",

  capDaily: () => "Try-ons are paused for today because we've reached our daily limit. Please come back tomorrow. You can still look at the outfits.",
  capBuyer: (n: number) => `You've made ${n} new previews today, which is the daily limit. Previews you've already seen are still available. New ones open again tomorrow.`,

  askPhone: (seller: string) =>
    [
      "Great choice! What's your WhatsApp number?",
      `${seller} will use it only to send your order confirmation card and delivery updates. It's deleted together with your photos (after ${RETENTION_DAYS} days, or when you type "delete my photos").`,
      "Type it like 98765 43210, or tap Skip.",
    ].join("\n"),
  phoneInvalid: () => "That doesn't look like a phone number. Please type it like 98765 43210 (or with the country code, like +44 7700 900123), or tap Skip.",
  orderSent: (seller: string, phone: string | null) =>
    `I've sent your order to ${seller} to confirm. You'll get your confirmation card here${phone ? `, and ${seller} will send it to your WhatsApp number ending ${phone.slice(-4)}` : ""}.`,
  waitingSeller: (seller: string) => `Your order is waiting for ${seller} to confirm.`,
  demoSellerLink: () => "Demo: open seller view",

  orderApproved: () => "Your order is confirmed! 🎉 Here's your confirmation card: this is what you ordered, on you.",
  cardLink: () => "Open your card (to save or share)",
  cardImageFooter: () => "Virtual try-on preview: the real fit and colour may vary slightly.",
  cardImageNoPhoto: () => "Try-on image deleted at the buyer's request.",
  card: (p: {
    label: string;
    priceInr: number | null;
    orderRef: string;
    disclosure: string | null;
    seller: string;
    /** jewellery added to the order */
    extras?: Array<{ label: string; priceInr: number | null }>;
    totalInr?: number | null;
    /** shown in the image but not part of the order (lip shade, or jewellery not ordered) */
    styling?: string[];
  }) => ({
    title: "Order confirmed",
    lines: [
      ...(p.extras?.length
        ? ["Ordered:", `• ${p.label}${inr(p.priceInr)}`, ...p.extras.map((e) => `• ${e.label}${inr(e.priceInr)}`), p.totalInr != null ? `Total ₹${p.totalInr.toLocaleString("en-IN")}` : ""]
        : [`${p.label}${inr(p.priceInr)}`]),
      `Order ${p.orderRef} · ${p.seller}`,
      p.styling?.length ? copy.cardStyling(p.styling) : "",
      p.disclosure ?? "",
    ].filter(Boolean),
  }),
  cardStyling: (items: string[]) => `Styling suggestion, not included: ${items.join(", ")}`,
  cardOrdered: () => "Ordered",
  cardTotal: (n: number) => `Total ₹${n.toLocaleString("en-IN")}`,
  orderRejected: (note: string | null) => `Sorry, the seller couldn't confirm this order${note ? `: ${note}` : "."} Would you like to try another outfit?`,
  ordered: () => "Your order is confirmed. Want to see another outfit on you?",

  deleted: (s: DeletionSummary) => {
    const shared = [
      s.phoneNumbers ? "your WhatsApp number" : "",
      s.cards ? `${s.cards} order card link${s.cards === 1 ? "" : "s"}` : "",
      s.familyLinks ? `${s.familyLinks} family vote link${s.familyLinks === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const also = shared.length ? ` Also deleted: ${shared.join(", ")}.` : "";
    if (!s.photos && !s.renders) return shared.length ? `You have no photos stored with us.${also}` : "You have no photos stored with us. Nothing to delete.";
    const parts = [`Deleted from our servers: ${s.photos} photo${s.photos === 1 ? "" : "s"} and ${s.renders} try-on image${s.renders === 1 ? "" : "s"}${s.looks ? ` (with ${s.looks} completed look${s.looks === 1 ? "" : "s"})` : ""}.`];
    if (s.renders) {
      const done = s.youcam.deleted + s.youcam.alreadyGone;
      parts.push(
        s.youcam.failed
          ? `We asked YouCam (our try-on provider) to delete them too; ${done} of ${s.renders} confirmed. YouCam's documentation says it deletes uploads automatically after 24 hours.`
          : `YouCam (our try-on provider) confirmed they're deleted on their side too.`,
      );
    }
    return parts.join(" ") + also;
  },
  revoked: (s: DeletionSummary) => `${copy.deleted(s)} You've withdrawn consent, so I won't use your photos again. Say "hi" to start over.`,

  // ---- complete the look ----
  lookIntro: () => "Let's complete the look. Choosing is free: nothing is made until you tap \"Show me\".",
  lookUnavailable: (problem: string) =>
    problem === "several_faces"
      ? "I can only complete the look when there's one person in the picture. Your preview is still here."
      : "I couldn't find your face clearly enough in this preview to add jewellery or lip colour. Your preview is still here.",
  pickEarring: () => "Earrings: which would you like to see?",
  earsCovered: () => "The outfit covers your ears in this picture (or already shows something there), so I can't add earrings to it.",
  neckQuestion: () => "Here's a close-up of your preview. Is your neck bare in this picture? I can only add a necklace if it is.",
  neckNotBare: () => "Then I won't add a necklace. Any jewellery already in the preview is illustrative and not included with the outfit.",
  pickNecklace: () => "Necklace: which would you like to see?",
  pickLip: () => "Lip colour that suits this outfit (a styling suggestion only, we don't sell it):",
  accessoryChoice: (label: string, priceInr: number | null) => `${label}${inr(priceInr)}`,
  lookBackToPreview: () => "Okay, back to your preview. It's still here.",
  lookNothing: () => "Nothing chosen, so there's nothing to add. Your preview is still here.",
  lookSummary: (p: { earring: string | null; necklace: string | null; lip: string | null }) =>
    [
      "Your look:",
      p.earring ? `• Earrings: ${p.earring}` : "",
      p.necklace ? `• Necklace: ${p.necklace}` : "",
      p.lip ? `• Lip colour: ${p.lip} (styling suggestion)` : "",
      "Jewellery is shown at small size on a full-length picture, so you'll also get a close-up: the close-up is the better guide.",
    ]
      .filter(Boolean)
      .join("\n"),
  lookWorking: () => "Putting your look together… this takes about 30 seconds. ⏳",
  lookStillWorking: () => "Still working on your look, almost there…",
  lookResult: () => "Here's the complete look.",
  lookCloseup: (hasJewellery: boolean, hasLip: boolean) =>
    [
      hasJewellery ? "Close-up. Jewellery is small in the full picture, so use this close-up as the better guide. It's drawn from the shop's photo of the item; size and how it sits may differ a little." : "Close-up.",
      hasLip ? "The lip colour is a styling suggestion, not part of your order." : "",
    ]
      .filter(Boolean)
      .join(" "),
  lookFailed: () => "Sorry, I couldn't make that look. Nothing was charged to you. Your preview is still here; you can try again or order as it is.",
  lookRefused: (reason: string, looksPerDay: number) =>
    reason === "daily_cap"
      ? "Looks are paused for today because we've reached our daily limit. Please come back tomorrow. Your preview is still here."
      : reason === "buyer_cap"
        ? `You've made ${looksPerDay} new looks today, which is the daily limit. Looks you've already seen are still available. New ones open again tomorrow.`
        : reason === "ears_covered"
          ? "The outfit covers your ears in this picture, so I can't add earrings to it."
          : "That look isn't available any more. Please choose again.",

  familyIntro: () =>
    [
      "Here's a link to ask your family. They'll see only this try-on image and the outfit name, and can vote yes or no. No login needed.",
      `You're choosing to share this image: anyone with the link can see it for ${VOTE_DAYS} days. It's deleted earlier if you type "delete my photos". Votes will show up here.`,
    ].join("\n"),
  familyOpenLink: () => "Open the family vote link",
  familyShareWhatsapp: () => "Share it on WhatsApp",
  familyShareText: (label: string, url: string) => `What do you think, should I buy this ${label}? Tap to vote: ${url}`,
  familyTally: (label: string, t: Tally, latest: { likes: boolean; name: string | null }) =>
    `Family vote on ${label}: 👍 ${t.yes} yes · 👎 ${t.no} no. ${latest.name ?? "Someone"} said ${latest.likes ? "yes" : "no"}.`,
  familyUnavailable: () => "Sorry, I can't make a family link for this preview. Please make a new preview first.",

  help: () => "You can: send a photo, pick an outfit, complete the look after a preview, type \"delete my photos\", or type \"stop\" to withdraw consent.",
};
