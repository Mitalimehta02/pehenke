/**
 * Every buyer- and seller-facing string. English only for now; keep all text
 * here so a Hindi table can be added later without touching the engine.
 */
import type { DeletionSummary } from "../consent/service";
import { RETENTION_DAYS } from "../consent/service";
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
  },

  greeting: (seller: string) => `Hi! Welcome to ${seller}. See any of our outfits on you before you order. 👗`,

  consent: () =>
    [
      "Before you send a photo:",
      "• To show you wearing an outfit, we send your photo to our try-on provider (YouCam).",
      `• Your photos and try-on images are deleted automatically after ${RETENTION_DAYS} days.`,
      "• Type \"delete my photos\" any time to delete them sooner.",
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

  orderSent: (seller: string) => `Great choice! I've sent your order to ${seller} to confirm. You'll get your confirmation card here.`,
  waitingSeller: (seller: string) => `Your order is waiting for ${seller} to confirm.`,
  demoSellerLink: () => "Demo: open seller view",

  orderApproved: () => "Your order is confirmed! 🎉 Here's your confirmation card: this is what you ordered, on you.",
  card: (p: { label: string; priceInr: number | null; orderRef: string; disclosure: string | null; seller: string }) => ({
    title: "Order confirmed",
    lines: [`${p.label}${inr(p.priceInr)}`, `Order ${p.orderRef} · ${p.seller}`, p.disclosure ?? ""].filter(Boolean),
  }),
  orderRejected: (note: string | null) => `Sorry, the seller couldn't confirm this order${note ? `: ${note}` : "."} Would you like to try another outfit?`,
  ordered: () => "Your order is confirmed. Want to see another outfit on you?",

  deleted: (s: DeletionSummary) => {
    if (!s.photos && !s.renders) return "You have no photos stored with us. Nothing to delete.";
    const parts = [`Deleted from our servers: ${s.photos} photo${s.photos === 1 ? "" : "s"} and ${s.renders} try-on image${s.renders === 1 ? "" : "s"}.`];
    if (s.renders) {
      const done = s.youcam.deleted + s.youcam.alreadyGone;
      parts.push(
        s.youcam.failed
          ? `We asked YouCam (our try-on provider) to delete them too; ${done} of ${s.renders} confirmed. YouCam's documentation says it deletes uploads automatically after 24 hours.`
          : `YouCam (our try-on provider) confirmed they're deleted on their side too.`,
      );
    }
    return parts.join(" ");
  },
  revoked: (s: DeletionSummary) => `${copy.deleted(s)} You've withdrawn consent, so I won't use your photos again. Say "hi" to start over.`,

  help: () => "You can: send a photo, pick an outfit, type \"delete my photos\", or type \"stop\" to withdraw consent.",
};
