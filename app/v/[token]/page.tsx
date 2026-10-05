import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getApp } from "@/lib/server/app";
import { VOTER_COOKIE } from "./voter";
import VoteForm from "./VoteForm";
import styles from "../../public.module.css";

export const dynamic = "force-dynamic";

// No preview image in link metadata: a WhatsApp preview would keep a copy of the
// buyer's photo after the link expires or is deleted.
export const metadata: Metadata = { title: "Help me choose · PehenKe", description: "Should I buy this? Tap to vote.", robots: { index: false, follow: false } };

/** Family vote: one try-on image, the outfit name, yes / no. No login. */
export default async function VotePage({ params }: PageProps<"/v/[token]">) {
  const { token } = await params;
  const app = await getApp();
  const vote = await app.family.findOpen(token);
  if (!vote) {
    return (
      <main className={styles.page}>
        <p className={styles.brand}>PehenKe</p>
        <h1 className={styles.title}>This link has expired</h1>
        <p className={styles.sub}>Family vote links work for 7 days, and stop sooner if the person who shared it deletes their photos.</p>
      </main>
    );
  }
  const mine = await app.family.myVote(vote.id, (await cookies()).get(VOTER_COOKIE)?.value ?? null);
  const until = vote.expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
  return (
    <main className={styles.page}>
      <p className={styles.brand}>Help me choose</p>
      <h1 className={styles.title}>{vote.garmentLabel}</h1>
      <p className={styles.sub}>Someone close to you is deciding whether to buy this, and wants your opinion.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.photo} src={`/api/vote/${token}`} alt={`Try-on preview: ${vote.garmentLabel}`} />
      <VoteForm token={token} initial={mine ? { likes: mine.likes, name: mine.name ?? "" } : null} />
      <p className={styles.small}>
        This is a virtual try-on preview. Only people with this link can see it, until {until}. Your vote and the name you type are shared only with the person who sent the link.
      </p>
    </main>
  );
}
