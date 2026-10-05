import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { sellerCopy } from "@/lib/engine/sellerCopy";
import { orderRef } from "@/lib/orders/cardData";
import { serverEnv } from "@/lib/env";
import { sellerDashboard, storageStats } from "@/lib/seller/dashboard";
import { getApp } from "@/lib/server/app";
import { isSeller } from "@/lib/server/auth";
import { ShareBox } from "@/app/_components/ShareBox";
import { links } from "@/lib/links";
import { formatPhone } from "@/lib/orders/phone";
import { AddGarment, AutoRefresh, CardActions, GarmentActions, GarmentShare, OrderDecision, OutcomeSelect, ResetDemo } from "./SellerClient";
import styles from "./seller.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Seller view · PehenKe", robots: { index: false } };

const inr = (n: number | null) => (n == null ? "" : `₹${n.toLocaleString("en-IN")}`);
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const ago = (d: Date) => {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export default async function SellerPage({ params, searchParams }: PageProps<"/seller/[slug]">) {
  const { slug } = await params;
  const key = ((await searchParams).key as string | undefined) ?? null;
  const app = await getApp();
  const seller = await app.prisma.seller.findUnique({ where: { slug } });
  if (!seller || !(await isSeller(seller, key))) notFound();

  const [d, storage] = await Promise.all([sellerDashboard(app.prisma, seller.id), storageStats(app.prisma)]);
  const limitMb = serverEnv().DB_STORAGE_LIMIT_MB;
  const media = (k: string) => `/api/media/${k}?seller=${encodeURIComponent(slug)}${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  const f = d.funnel;
  const steps = [
    { label: "Chats started", value: f.chats },
    { label: "Agreed to photo terms", value: f.consented },
    { label: "Own photos accepted", value: f.photos },
    { label: "Try-on previews shown", value: f.previews },
    { label: "Orders placed", value: f.orders },
    { label: "Cards approved", value: f.approved },
    { label: "Delivered", value: f.delivered },
  ];
  const maxStep = Math.max(1, ...steps.map((s) => s.value));
  const usedPct = Math.min(100, (storage.dbBytes / (limitMb * 1024 * 1024)) * 100);
  const chatUrl = links.chat(app.baseUrl, slug);

  return (
    <div className={styles.page}>
      <AutoRefresh seconds={d.pending.length ? 15 : 30} />
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Seller view</p>
          <h1>{seller.name}</h1>
        </div>
        <a className={styles.chatLink} href={`/chat/${slug}`} target="_blank" rel="noreferrer">
          Open shop chat ↗
        </a>
      </header>
      {seller.isDemo && <p className={styles.demoNote}>Demo shop: anyone with this link can act as the seller. Real shops use a private link.</p>}

      <section className={styles.section}>
        <h2>Share your shop</h2>
        <p className={styles.hint}>Buyers open this link, send one photo, and see your outfits on themselves. Post it in your WhatsApp status or groups.</p>
        <ShareBox label="Your shop chat link" url={chatUrl} waText={sellerCopy.waShop(seller.name, chatUrl)} />
      </section>

      <section className={styles.section}>
        <h2>
          Orders to confirm <span className={styles.count}>{d.pending.length}</span>
        </h2>
        {!d.pending.length && <p className={styles.empty}>No orders waiting. New orders appear here automatically.</p>}
        {d.pending.map((o) => {
          const pc = (o.pixelSummary as { pixelChecks?: { regionUnchanged?: boolean | null; changedPct?: number | null; length?: { determined: boolean; hemPos: number; expected: string } | null } } | null)?.pixelChecks;
          return (
            <article key={o.id} className={styles.order}>
              <div className={styles.orderTop}>
                {o.tryOn?.outputKey ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.orderImg} src={media(o.tryOn.outputKey)} alt="Buyer's try-on" />
                ) : (
                  <div className={`${styles.orderImg} ${styles.noImg}`}>Photo deleted</div>
                )}
                <div className={styles.orderInfo}>
                  <p className={styles.orderTitle}>{o.garment.label}</p>
                  <p className={styles.meta}>
                    {inr(o.garment.priceInr)} · {orderRef(o.id)} · {ago(o.createdAt)}
                  </p>
                  <ul className={styles.checks}>
                    <li className={pc?.regionUnchanged ? styles.bad : styles.good}>
                      <span aria-hidden>{pc?.regionUnchanged ? "⚠" : "✓"}</span>
                      {pc?.regionUnchanged ? "Clothes look unchanged" : `Outfit changed${pc?.changedPct != null ? ` (${pc.changedPct}% of clothing area)` : ""}`}
                    </li>
                    {pc?.length?.determined && (
                      <li className={styles.neutral}>
                        <span aria-hidden>ⓘ</span>Hem at {Math.round(pc.length.hemPos * 100)}% of height (expected {pc.length.expected})
                      </li>
                    )}
                  </ul>
                </div>
              </div>
              {o.disclosureText && <p className={styles.disclosure}>Card will say: “{o.disclosureText}”</p>}
              <p className={styles.hint}>Check the image: is it the right outfit, with nothing extra the buyer didn&apos;t order?</p>
              <OrderDecision slug={slug} sellerKey={key} orderId={o.id} />
            </article>
          );
        })}
      </section>

      <section className={styles.section}>
        <h2>How buyers are doing</h2>
        <div className={styles.funnel} role="table" aria-label="Buyer funnel">
          {steps.map((s) => (
            <div key={s.label} className={styles.funnelRow} role="row" title={`${s.label}: ${s.value}`}>
              <span className={styles.funnelLabel} role="cell">
                {s.label}
              </span>
              <span className={styles.funnelTrack} role="cell" aria-hidden>
                <span className={styles.funnelBar} style={{ width: `${(s.value / maxStep) * 100}%` }} />
              </span>
              <span className={styles.funnelValue} role="cell">
                {s.value}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.tiles}>
          <div className={styles.tile}>
            <span className={styles.tileValue}>{f.refused}</span>
            <span className={styles.tileLabel}>Refused at door</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileValue}>{f.cancelled}</span>
            <span className={styles.tileLabel}>Cancelled</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileValue}>{d.units.wastedPct}%</span>
            <span className={styles.tileLabel}>
              Units wasted on blocked previews ({d.units.wasted} of {d.units.units})
            </span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Your outfits</h2>
        <AddGarment slug={slug} sellerKey={key} />
        <ul className={styles.garments}>
          {d.garments.map((g) => {
            const tryable = g.active && (g.gateStatus === "approved" || (g.gateStatus === "needs_review" && g.sellerConfirmed));
            const status = g.gateStatus === "needs_review" && g.sellerConfirmed ? "approved" : g.gateStatus;
            return (
              <li key={g.id} className={styles.garment}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.garmentImg} src={media(g.photoKey)} alt="" />
                <div className={styles.garmentInfo}>
                  <p className={styles.garmentTitle}>{g.label}</p>
                  <p className={styles.meta}>
                    {[inr(g.priceInr), sellerCopy.categories[g.category], sellerCopy.photoTypes[g.photoType]].filter(Boolean).join(" · ")}
                  </p>
                  <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
                    <span aria-hidden>{status === "approved" ? "✓" : status === "rejected" ? "✕" : "!"}</span>
                    {g.gateStatus === "needs_review" && g.sellerConfirmed ? "Ready (you checked it)" : sellerCopy.gateStatus[g.gateStatus]}
                  </span>
                  {!tryable && g.active && status !== "approved" && g.gateAdvice && <p className={styles.advice}>{g.gateAdvice}</p>}
                  {tryable && (
                    <GarmentShare url={links.chat(app.baseUrl, slug, g.id)} waText={sellerCopy.waGarment(g.label, g.priceInr, links.chat(app.baseUrl, slug, g.id))} />
                  )}
                  <GarmentActions slug={slug} sellerKey={key} garmentId={g.id} active={g.active} needsChecklist={g.gateStatus === "needs_review" && !g.sellerConfirmed} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {d.recent.length > 0 && (
        <section className={styles.section}>
          <h2>Recent orders</h2>
          <ul className={styles.recent}>
            {d.recent.map((o) => {
              if (o.cardStatus !== "approved") {
                return (
                  <li key={o.id}>
                    <div>
                      <p className={styles.garmentTitle}>{o.garment.label}</p>
                      <p className={styles.meta}>
                        {orderRef(o.id)} · Rejected · {ago(o.createdAt)}
                      </p>
                    </div>
                  </li>
                );
              }
              const ref = orderRef(o.id);
              const cardUrl = o.cardToken ? links.card(app.baseUrl, o.cardToken) : null;
              return (
                <li key={o.id} className={styles.approvedOrder}>
                  <div className={styles.approvedTop}>
                    {o.cardToken ? (
                      <a href={links.card("", o.cardToken)} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className={styles.cardThumb} src={links.cardImage("", o.cardToken)} alt={`Order card ${ref}`} />
                      </a>
                    ) : (
                      <div className={`${styles.cardThumb} ${styles.noImg}`} style={{ height: 112 }}>
                        Photo deleted
                      </div>
                    )}
                    <div className={styles.approvedInfo}>
                      <p className={styles.garmentTitle}>{o.garment.label}</p>
                      <p className={styles.meta}>
                        {ref} · {inr(o.garment.priceInr)} · {ago(o.createdAt)}
                      </p>
                      <p className={styles.meta}>{o.buyerWhatsapp ? `Buyer's WhatsApp: ${formatPhone(o.buyerWhatsapp)}` : "No WhatsApp number given"}</p>
                      <OutcomeSelect slug={slug} sellerKey={key} orderId={o.id} outcome={o.outcome} />
                    </div>
                  </div>
                  {cardUrl && (
                    <CardActions
                      slug={slug}
                      sellerKey={key}
                      orderId={o.id}
                      waTo={o.buyerWhatsapp}
                      cardText={sellerCopy.waCard(seller.name, ref, o.garment.label, cardUrl)}
                      dispatchText={sellerCopy.waDispatched(seller.name, ref, o.garment.label, cardUrl)}
                      sentAgo={o.cardSentAt ? ago(o.cardSentAt) : null}
                      dispatchedAgo={o.dispatchedAt ? ago(o.dispatchedAt) : null}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className={styles.footer}>
        <div className={styles.storage}>
          <span>
            Database {mb(storage.dbBytes)} of {limitMb >= 1024 ? `${limitMb / 1024} GB` : `${limitMb} MB`} (Neon free plan: writes stop at the limit)
          </span>
          <span className={styles.storageTrack} aria-hidden>
            <span className={styles.storageBar} style={{ width: `${usedPct}%` }} />
          </span>
          <span className={styles.meta}>
            Images {mb(storage.blobBytes)} in {storage.blobCount} files · {d.units.renders} renders, {d.units.units} units
          </span>
        </div>
        {seller.isDemo && <ResetDemo slug={slug} sellerKey={key} />}
      </footer>
    </div>
  );
}
