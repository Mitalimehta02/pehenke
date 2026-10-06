import type { Metadata } from "next";
import Link from "next/link";
import { Prisma } from "@/lib/generated/prisma/client";
import { getApp } from "@/lib/server/app";
import styles from "../info.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Image credits · PehenKe" };

interface Credit {
  source: string;
  sourceUrl: string;
  author: string;
  licence: string;
  licenceUrl: string | null;
  /** how the image was changed, if it was (CC BY-SA asks for this) */
  modified?: string;
}

/** Every seeded demo image with its source, author and licence (copied from spike-assets/SOURCES.md at seed time). */
export default async function CreditsPage() {
  const { prisma } = await getApp();
  const [garments, samples, accessories] = await Promise.all([
    prisma.garment.findMany({ where: { credit: { not: Prisma.DbNull }, seller: { isDemo: true } }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, photoKey: true, credit: true } }),
    prisma.buyerPhoto.findMany({ where: { isSample: true }, orderBy: { createdAt: "asc" }, select: { id: true, sampleName: true, blobKey: true, credit: true } }),
    prisma.accessory.findMany({ where: { credit: { not: Prisma.DbNull }, seller: { isDemo: true } }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, photoKey: true, credit: true } }),
  ]);
  const rows = [
    ...samples.map((s) => ({ id: s.id, what: s.sampleName ?? "Sample photo", key: s.blobKey, credit: s.credit as Credit | null })),
    ...garments.map((g) => ({ id: g.id, what: g.label, key: g.photoKey, credit: g.credit as Credit | null })),
    ...accessories.map((a) => ({ id: a.id, what: a.label, key: a.photoKey, credit: a.credit as Credit | null })),
  ].filter((r) => r.credit);

  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>
        ← PehenKe
      </Link>
      <h1>Image credits</h1>
      <p className={styles.lead}>
        The demo shop (outfits and jewellery) and sample models use openly licensed photos from Wikimedia Commons. Try-on previews and looks made from these photos are derivatives and carry the same licence.
      </p>
      <ul className={styles.credits}>
        {rows.map((r) => (
          <li key={r.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/media/${r.key}`} alt="" />
            <div>
              <p className={styles.what}>{r.what}</p>
              <p>
                <a href={r.credit!.sourceUrl} target="_blank" rel="noreferrer">
                  {r.credit!.source.replace(/\.(jpe?g|png)$/i, "")}
                </a>
              </p>
              <p>By {r.credit!.author || "unknown"}</p>
              {r.credit!.modified && <p>Changed: {r.credit!.modified}</p>}
              <p>
                Licence:{" "}
                {r.credit!.licenceUrl ? (
                  <a href={r.credit!.licenceUrl} target="_blank" rel="noreferrer">
                    {r.credit!.licence}
                  </a>
                ) : (
                  r.credit!.licence
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {!rows.length && <p className={styles.lead}>No demo images are loaded yet.</p>}
    </main>
  );
}
