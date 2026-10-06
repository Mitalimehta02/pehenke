"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { sellerCopy } from "@/lib/engine/sellerCopy";
import { resizeForUpload } from "@/lib/client/resizeImage";
import type { OrderOutcome } from "@/lib/generated/prisma/enums";
import { WaIcon } from "@/app/_components/ShareBox";
import { waLink } from "@/lib/links";
import { confirmAccessoryCrop, confirmChecklist, decideOrder, markCardSent, markDispatched, removeAccessory, resetDemoData, setAccessoryActive, setGarmentActive, setOutcome } from "./actions";
import styles from "./seller.module.css";

type Props = { slug: string; sellerKey: string | null };

/** Keep the page fresh so new orders show up without a reload. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

export function OrderDecision({ slug, sellerKey, orderId }: Props & { orderId: string }) {
  const [pending, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  if (rejecting) {
    return (
      <div className={styles.rejectBox}>
        <label className={styles.label}>
          Reason (sent to the buyer)
          <input className={styles.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. out of stock in this colour" maxLength={140} />
        </label>
        <div className={styles.row}>
          <button className={styles.secondary} disabled={pending} onClick={() => setRejecting(false)}>
            Back
          </button>
          <button className={styles.danger} disabled={pending} onClick={() => start(() => decideOrder(slug, sellerKey, orderId, "reject", note))}>
            {pending ? "Sending…" : "Reject order"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <button className={styles.secondary} disabled={pending} onClick={() => setRejecting(true)}>
        Reject
      </button>
      <button className={styles.primary} disabled={pending} onClick={() => start(() => decideOrder(slug, sellerKey, orderId, "approve"))}>
        {pending ? "Sending…" : "Approve & send card"}
      </button>
    </div>
  );
}

export function OutcomeSelect({ slug, sellerKey, orderId, outcome }: Props & { orderId: string; outcome: OrderOutcome }) {
  const [pending, start] = useTransition();
  return (
    <select
      className={styles.select}
      value={outcome}
      disabled={pending}
      aria-label="Delivery outcome"
      onChange={(e) => start(() => setOutcome(slug, sellerKey, orderId, e.target.value as OrderOutcome))}
    >
      {(Object.keys(sellerCopy.outcomes) as OrderOutcome[]).map((o) => (
        <option key={o} value={o}>
          {sellerCopy.outcomes[o]}
        </option>
      ))}
    </select>
  );
}

export function GarmentActions({ slug, sellerKey, garmentId, active, needsChecklist }: Props & { garmentId: string; active: boolean; needsChecklist: boolean }) {
  const [pending, start] = useTransition();
  const [ticks, setTicks] = useState<boolean[]>(sellerCopy.checklist.map(() => false));
  return (
    <>
      {needsChecklist && active && (
        <fieldset className={styles.checklist}>
          <legend>Check the photo, then publish</legend>
          {sellerCopy.checklist.map((c, i) => (
            <label key={c}>
              <input type="checkbox" checked={ticks[i]} onChange={(e) => setTicks((t) => t.map((v, j) => (j === i ? e.target.checked : v)))} /> {c}
            </label>
          ))}
          <button className={styles.primary} disabled={pending || !ticks.every(Boolean)} onClick={() => start(() => confirmChecklist(slug, sellerKey, garmentId))}>
            Publish for try-on
          </button>
        </fieldset>
      )}
      <button className={styles.link} disabled={pending} onClick={() => start(() => setGarmentActive(slug, sellerKey, garmentId, !active))}>
        {active ? "Hide from buyers" : "Show to buyers"}
      </button>
    </>
  );
}

export function AddGarment({ slug, sellerKey }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [category, setCategory] = useState("full_body");
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("photo");
    if (file instanceof File && file.size) form.set("photo", await resizeForUpload(file, 2048), "garment.jpg");
    if (sellerKey) form.set("key", sellerKey);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/seller/${slug}/garments`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't add the item.");
      setMsg(
        data.gateStatus === "approved"
          ? { kind: "ok", text: "Added. The photo passed the check and is ready for try-on." }
          : data.gateStatus === "needs_review"
            ? { kind: "warn", text: "Added. Please check the photo below and publish it." }
            : { kind: "bad", text: `This photo can't be used for try-on. ${data.gateAdvice ?? ""}` },
      );
      formRef.current?.reset();
      setPreview(null);
      router.refresh();
    } catch (err) {
      setMsg({ kind: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <button className={styles.addButton} onClick={() => setOpen(true)}>
          + Add an outfit
        </button>
        {msg && <p className={`${styles.msg} ${styles[`msg_${msg.kind}`]}`}>{msg.text}</p>}
      </>
    );
  }
  return (
    <form ref={formRef} className={styles.addForm} onSubmit={submit}>
      <label className={styles.photoPick}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview ? <img src={preview} alt="" /> : <span>Tap to add a photo</span>}
        <input
          name="photo"
          type="file"
          accept="image/*"
          required
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            setPreview(f ? URL.createObjectURL(f) : null);
          }}
        />
      </label>
      <p className={styles.hint}>Best: the whole item on a mannequin or hanger against a plain wall, nothing else in the picture.</p>
      <label className={styles.label}>
        Name
        <input className={styles.input} name="label" required maxLength={80} placeholder="e.g. Blue cotton kurti" />
      </label>
      <div className={styles.twoCol}>
        <label className={styles.label}>
          What is it?
          <select className={styles.select} name="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(sellerCopy.categories).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.label}>
          Price (₹)
          <input className={styles.input} name="priceInr" inputMode="numeric" placeholder="1499" />
        </label>
      </div>
      <div className={styles.twoCol}>
        <label className={styles.label}>
          Photo shows it
          <select className={styles.select} name="photoType" defaultValue="mannequin">
            {Object.entries(sellerCopy.photoTypes).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.label}>
          Length
          <select className={styles.select} name="length" defaultValue="">
            <option value="">Not sure</option>
            <option value="crop">Cropped / blouse</option>
            <option value="hip">Hip</option>
            <option value="knee">Knee</option>
            <option value="ankle">Ankle</option>
            <option value="floor">Floor</option>
          </select>
        </label>
      </div>
      {category === "full_body" && (
        <label className={styles.checkLine}>
          <input type="checkbox" name="includesBlouse" /> The photo shows the blouse too (sarees)
        </label>
      )}
      <label className={styles.label}>
        Notes (optional)
        <input className={styles.input} name="notes" maxLength={300} placeholder="e.g. blouse piece included, unstitched" />
      </label>
      <div className={styles.row}>
        <button type="button" className={styles.secondary} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button className={styles.primary} disabled={busy}>
          {busy ? "Checking photo…" : "Add outfit"}
        </button>
      </div>
      {msg && <p className={`${styles.msg} ${styles[`msg_${msg.kind}`]}`}>{msg.text}</p>}
    </form>
  );
}

export function ResetDemo({ slug, sellerKey }: Props) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className={styles.reset}>
      <button
        className={styles.secondary}
        disabled={pending}
        onClick={() => {
          if (!confirm("Reset the demo? This deletes all demo chats, orders and uploaded photos. Seeded outfits and sample photos stay.")) return;
          start(async () => {
            const r = await resetDemoData(slug, sellerKey);
            setDone(`Reset: ${r.chats} chats, ${r.orders} orders, ${r.photos} photos, ${r.renders} renders, ${r.garments} added outfits removed.`);
          });
        }}
      >
        {pending ? "Resetting…" : "Reset demo data"}
      </button>
      {done && <p className={styles.meta}>{done}</p>}
    </div>
  );
}

/** Per-outfit link: opens the shop chat with this outfit preselected. */
export function GarmentShare({ url, waText }: { url: string; waText: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.shareRow}>
      <a className={styles.waSmall} href={waLink(waText)} target="_blank" rel="noreferrer">
        <WaIcon /> Share
      </a>
      <button
        type="button"
        className={styles.link}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
          } catch {
            window.prompt("Copy this link:", url);
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        }}
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}

/**
 * Approved order: send the card to the buyer on WhatsApp (wa.me with the card
 * link; to their number if they gave one), then "Mark dispatched", which
 * offers to send the card again with a dispatch note.
 */
export function CardActions({
  slug,
  sellerKey,
  orderId,
  waTo,
  cardText,
  dispatchText,
  sentAgo,
  dispatchedAgo,
}: Props & { orderId: string; waTo: string | null; cardText: string; dispatchText: string; sentAgo: string | null; dispatchedAgo: string | null }) {
  const [pending, start] = useTransition();
  return (
    <div className={styles.cardActions}>
      <a className={styles.waButton} href={waLink(cardText, waTo)} target="_blank" rel="noreferrer" onClick={() => start(() => markCardSent(slug, sellerKey, orderId))}>
        <WaIcon /> {sentAgo ? "Send card again" : "Send card to buyer on WhatsApp"}
      </a>
      <p className={styles.meta}>{sentAgo ? `Card sent ${sentAgo}` : "Card not sent yet"}{waTo ? "" : " · buyer gave no number: pick their chat in WhatsApp"}</p>
      {dispatchedAgo ? (
        <>
          <p className={styles.dispatched}>
            <span aria-hidden>✓</span> Dispatched {dispatchedAgo}
          </p>
          <a className={styles.waOutline} href={waLink(dispatchText, waTo)} target="_blank" rel="noreferrer" onClick={() => start(() => markCardSent(slug, sellerKey, orderId))}>
            <WaIcon /> Send the card with a dispatch note
          </a>
        </>
      ) : (
        <button className={styles.secondary} style={{ width: "100%", marginTop: 8 }} disabled={pending} onClick={() => start(() => markDispatched(slug, sellerKey, orderId))}>
          {pending ? "Saving…" : "Mark dispatched"}
        </button>
      )}
    </div>
  );
}

/** "Add jewellery" for complete-the-look: earrings or a necklace, with the photo rule shown up front. */
export function AddJewellery({ slug, sellerKey }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [type, setType] = useState<"earring" | "necklace">("earring");
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("photo");
    if (file instanceof File && file.size) form.set("photo", await resizeForUpload(file, 2048), "jewellery.jpg");
    if (sellerKey) form.set("key", sellerKey);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/seller/${slug}/accessories`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't add the item.");
      setMsg(
        data.gateStatus === "approved"
          ? { kind: "ok", text: "Added. The photo passed the check and buyers can now add it to a look." }
          : data.gateStatus === "needs_review"
            ? { kind: "warn", text: `Added, one step left. ${data.gateAdvice ?? ""}` }
            : { kind: "bad", text: `This photo can't be used. ${data.gateAdvice ?? ""}` },
      );
      formRef.current?.reset();
      setPreview(null);
      router.refresh();
    } catch (err) {
      setMsg({ kind: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <button className={styles.addButton} onClick={() => setOpen(true)}>
          + Add jewellery
        </button>
        {msg && <p className={`${styles.msg} ${styles[`msg_${msg.kind}`]}`}>{msg.text}</p>}
      </>
    );
  }
  return (
    <form ref={formRef} className={styles.addForm} onSubmit={submit}>
      <label className={styles.label}>
        What is it?
        <select className={styles.select} name="type" value={type} onChange={(e) => setType(e.target.value as "earring" | "necklace")} style={{ width: "100%" }}>
          <option value="earring">Earrings</option>
          <option value="necklace">Necklace</option>
        </select>
      </label>
      <p className={styles.hint}>{sellerCopy.accessoryBest[type]} It is drawn on the buyer exactly as it looks in your photo.</p>
      <label className={styles.photoPick}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview ? <img src={preview} alt="" /> : <span>Tap to add a photo</span>}
        <input
          name="photo"
          type="file"
          accept="image/*"
          required
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            setPreview(f ? URL.createObjectURL(f) : null);
          }}
        />
      </label>
      <div className={styles.twoCol}>
        <label className={styles.label}>
          Name
          <input className={styles.input} name="label" required maxLength={80} placeholder={type === "earring" ? "e.g. Gold jhumka" : "e.g. Temple necklace"} />
        </label>
        <label className={styles.label}>
          Price (₹, optional)
          <input className={styles.input} name="priceInr" inputMode="numeric" placeholder="450" />
        </label>
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.secondary} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button className={styles.primary} disabled={busy}>
          {busy ? "Checking photo…" : "Add jewellery"}
        </button>
      </div>
      {msg && <p className={`${styles.msg} ${styles[`msg_${msg.kind}`]}`}>{msg.text}</p>}
    </form>
  );
}

/** Jewellery item actions: confirm the suggested one-earring crop, hide/show, remove. */
export function AccessoryActions({ slug, sellerKey, accessoryId, active, needsCrop, usable }: Props & { accessoryId: string; active: boolean; needsCrop: boolean; usable: boolean }) {
  const [pending, start] = useTransition();
  return (
    <>
      {needsCrop && (
        <div className={styles.row}>
          <button className={styles.primary} disabled={pending} onClick={() => start(() => confirmAccessoryCrop(slug, sellerKey, accessoryId))}>
            {pending ? "Saving…" : "Use this crop"}
          </button>
        </div>
      )}
      <div className={styles.shareRow}>
        {usable && (
          <button className={styles.link} disabled={pending} onClick={() => start(() => setAccessoryActive(slug, sellerKey, accessoryId, !active))}>
            {active ? "Hide from buyers" : "Show to buyers"}
          </button>
        )}
        <button
          className={styles.link}
          disabled={pending}
          onClick={() => {
            if (confirm("Remove this jewellery item?")) start(() => removeAccessory(slug, sellerKey, accessoryId));
          }}
        >
          Remove
        </button>
      </div>
    </>
  );
}
