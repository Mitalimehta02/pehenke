import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { links } from "@/lib/links";
import { orderRef } from "@/lib/orders/cardData";
import { getApp } from "@/lib/server/app";
import styles from "../../public.module.css";

export const dynamic = "force-dynamic";

async function load(token: string) {
  return (await getApp()).orders.cardByToken(token);
}

export async function generateMetadata({ params }: PageProps<"/card/[token]">): Promise<Metadata> {
  const { token } = await params;
  const order = await load(token);
  const robots = { index: false, follow: false };
  if (!order) return { title: "Card not available", robots };
  const app = await getApp();
  const title = `Order ${orderRef(order.id)} · ${order.seller.name}`;
  return {
    title,
    description: `${order.garment.label}: what you ordered, on you.`,
    robots,
    // the link preview in WhatsApp shows the card itself
    openGraph: { title, description: `${order.garment.label}: what you ordered, on you.`, images: [{ url: links.cardImage(app.baseUrl, token), width: 1080 }] },
  };
}

/** The public order card (sent to the buyer on WhatsApp by the seller). */
export default async function CardPage({ params }: PageProps<"/card/[token]">) {
  const { token } = await params;
  const order = await load(token);
  if (!order) notFound();
  const img = links.cardImage("", token);
  return (
    <main className={styles.page}>
      <p className={styles.brand}>{order.seller.name}</p>
      <h1 className={styles.title}>Order {orderRef(order.id)} confirmed</h1>
      <p className={styles.sub}>This is what you ordered, on you.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.card} src={img} alt={`Order card: ${order.garment.label}, shown on the buyer`} />
      <a className={styles.button} href={`${img}?download=1`}>
        Save the card
      </a>
      <p className={styles.small}>
        Only people with this link can see this card. It stops working if you delete your photos in the shop&apos;s chat.
      </p>
    </main>
  );
}
