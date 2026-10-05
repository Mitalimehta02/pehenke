"use client";

import { useState, useTransition } from "react";
import { MAX_NAME } from "@/lib/family/limits";
import { castVote } from "./actions";
import styles from "../../public.module.css";

export default function VoteForm({ token, initial }: { token: string; initial: { likes: boolean; name: string } | null }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState(initial?.name ?? "");
  const [voted, setVoted] = useState<boolean | null>(initial?.likes ?? null);
  const [error, setError] = useState<string | null>(null);

  const vote = (likes: boolean) =>
    start(async () => {
      setError(null);
      const r = await castVote(token, likes, name);
      if (r.ok) setVoted(likes);
      else setError(r.error);
    });

  return (
    <>
      <p className={styles.question}>Should they buy it?</p>
      <label className={styles.nameLabel}>
        Your name (optional)
        <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} placeholder="e.g. Mum, Priya" autoComplete="given-name" />
      </label>
      <div className={styles.choices}>
        <button className={`${styles.yes} ${voted === true ? styles.chosen : ""}`} disabled={pending} onClick={() => vote(true)} aria-pressed={voted === true}>
          👍 Yes
        </button>
        <button className={`${styles.no} ${voted === false ? styles.chosen : ""}`} disabled={pending} onClick={() => vote(false)} aria-pressed={voted === false}>
          👎 No
        </button>
      </div>
      {voted !== null && !error && <p className={styles.thanks}>Thanks! You voted {voted ? "yes" : "no"}. You can change your vote any time.</p>}
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}
