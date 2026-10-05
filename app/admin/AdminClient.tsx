"use client";

import { useActionState, useState, useTransition } from "react";
import { ShareBox } from "@/app/_components/ShareBox";
import { sellerCopy } from "@/lib/engine/sellerCopy";
import type { CreatedSeller } from "@/lib/sellers/onboard";
import { addSeller, login, logout, newSellerLink } from "./actions";
import styles from "../seller/[slug]/seller.module.css";

export function AdminLogin() {
  const [error, action, pending] = useActionState(login, null);
  return (
    <form action={action} className={styles.addForm}>
      <label className={styles.label}>
        Admin secret
        <input className={styles.input} name="secret" type="password" autoComplete="current-password" required />
      </label>
      <div className={styles.row}>
        <button className={styles.primary} disabled={pending}>
          {pending ? "Checking…" : "Sign in"}
        </button>
      </div>
      {error && <p className={`${styles.msg} ${styles.msg_bad}`}>{error}</p>}
    </form>
  );
}

export function Logout() {
  const [pending, start] = useTransition();
  return (
    <button className={styles.chatLink} style={{ border: 0, cursor: "pointer" }} disabled={pending} onClick={() => start(() => logout())}>
      Sign out
    </button>
  );
}

/** The two links for a new (or re-linked) seller. The private one is shown only now. */
export function SellerLinks({ s, fresh }: { s: CreatedSeller; fresh: boolean }) {
  return (
    <div className={`${styles.msg} ${styles.msg_ok}`} style={{ padding: 12, width: "100%" }}>
      <strong>
        {fresh ? `${s.name} is ready.` : `New seller link for ${s.name}.`}
      </strong>{" "}
      {fresh ? "Send the seller their private link; they add outfits there." : "The old link no longer works."}
      <ShareBox
        secret
        label="Seller link (private)"
        url={s.sellerUrl}
        hint="Shown only once. Anyone with this link can manage the shop. Send it only to the seller."
        waText={sellerCopy.waSellerLink(s.name, s.sellerUrl)}
        waLabel="Send to seller"
      />
      <ShareBox label="Shop chat link (for buyers)" url={s.chatUrl} waText={sellerCopy.waShop(s.name, s.chatUrl)} />
    </div>
  );
}

export function CreateSeller() {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSeller | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await addSeller(name, slug.trim());
      if (r.ok) {
        setCreated(r.seller);
        setName("");
        setSlug("");
      } else setError(r.error);
    });
  };

  return (
    <>
      <form className={styles.addForm} onSubmit={submit}>
        <label className={styles.label}>
          Shop name
          <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} placeholder="e.g. Rani Fashion, Jaipur" />
        </label>
        <label className={styles.label}>
          Link name (optional)
          <input
            className={styles.input}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
            placeholder="made from the shop name"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <div className={styles.row}>
          <button className={styles.primary} disabled={pending}>
            {pending ? "Creating…" : "Create seller"}
          </button>
        </div>
        {error && <p className={`${styles.msg} ${styles.msg_bad}`}>{error}</p>}
      </form>
      {created && <SellerLinks s={created} fresh />}
    </>
  );
}

export function NewLinkButton({ sellerId, name }: { sellerId: string; name: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CreatedSeller | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (result) return <SellerLinks s={result} fresh={false} />;
  return (
    <div>
      <button
        className={styles.link}
        disabled={pending}
        onClick={() => {
          if (!confirm(`Issue a new seller link for ${name}? Their current link will stop working.`)) return;
          start(async () => {
            const r = await newSellerLink(sellerId);
            if (r.ok) setResult(r.seller);
            else setError(r.error);
          });
        }}
      >
        {pending ? "…" : "New seller link"}
      </button>
      {error && <p className={styles.meta}>{error}</p>}
    </div>
  );
}
