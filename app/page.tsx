import Link from "next/link";
import styles from "./info.module.css";

export default function Home() {
  return (
    <main className={`${styles.page} ${styles.landing}`}>
      <p className={styles.brand}>PehenKe</p>
      <h1 className={styles.hero}>See it on you before you buy.</h1>
      <ol className={styles.lines}>
        <li>Small clothing sellers on WhatsApp share outfits, but buyers can&apos;t tell how they&apos;ll look.</li>
        <li>PehenKe lets a buyer send one photo and see the seller&apos;s outfit on themselves, in the chat.</li>
        <li>That try-on becomes the order confirmation card, so fewer cash-on-delivery orders get refused.</li>
      </ol>
      <Link href="/chat/meera-boutique" className={styles.cta}>
        Try the demo
      </Link>
      <p className={styles.small}>
        <Link href="/credits">Image credits</Link>
      </p>
    </main>
  );
}
