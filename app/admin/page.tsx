import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApp } from "@/lib/server/app";
import { adminEnabled, isAdmin } from "@/lib/server/admin";
import { links } from "@/lib/links";
import { AdminLogin, CreateSeller, NewLinkButton, Logout } from "./AdminClient";
import styles from "../seller/[slug]/seller.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin · PehenKe", robots: { index: false, follow: false } };

/** Onboard real sellers. Exists only when ADMIN_SECRET is set. */
export default async function AdminPage() {
  if (!adminEnabled()) notFound();
  if (!(await isAdmin())) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>PehenKe</p>
            <h1>Admin</h1>
          </div>
        </header>
        <section className={styles.section}>
          <AdminLogin />
        </section>
      </div>
    );
  }

  const app = await getApp();
  const sellers = await app.prisma.seller.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { garments: true, orders: true, conversations: true } } },
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>PehenKe admin</p>
          <h1>Sellers</h1>
        </div>
        <Logout />
      </header>

      <section className={styles.section}>
        <h2>Add a seller</h2>
        <CreateSeller />
      </section>

      <section className={styles.section}>
        <h2>
          All shops <span className={styles.count}>{sellers.length}</span>
        </h2>
        <ul className={styles.recent}>
          {sellers.map((s) => (
            <li key={s.id}>
              <div>
                <p className={styles.garmentTitle}>
                  {s.name} {s.isDemo && <span className={styles.meta}>(demo)</span>}
                </p>
                <p className={styles.meta}>
                  <a href={links.chat("", s.slug)} target="_blank" rel="noreferrer">
                    /chat/{s.slug}
                  </a>{" "}
                  · {s._count.garments} outfits · {s._count.conversations} chats · {s._count.orders} orders
                </p>
              </div>
              {!s.isDemo && <NewLinkButton sellerId={s.id} name={s.name} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
