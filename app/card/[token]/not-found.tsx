import styles from "../../public.module.css";

export default function CardNotFound() {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>PehenKe</p>
      <h1 className={styles.title}>This card isn&apos;t available</h1>
      <p className={styles.sub}>The link may be mistyped, or the buyer deleted their photos, which removes the card too.</p>
    </main>
  );
}
