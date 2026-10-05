"use client";

import { useState } from "react";
import { waLink } from "@/lib/links";
import styles from "./share.module.css";

/**
 * A link with "Copy" and "Share on WhatsApp" (a wa.me link with prefilled
 * text). `secret` marks a private link (seller link): shown with a warning.
 */
export function ShareBox({
  label,
  url,
  waText,
  waTo,
  waLabel = "Share on WhatsApp",
  secret,
  hint,
  onWhatsApp,
}: {
  label: string;
  url: string;
  waText?: string;
  waTo?: string | null;
  waLabel?: string;
  secret?: boolean;
  hint?: string;
  onWhatsApp?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link:", url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className={`${styles.box} ${secret ? styles.secret : ""}`}>
      <p className={styles.label}>
        {secret && <span aria-hidden>🔒 </span>}
        {label}
      </p>
      <p className={styles.url}>{url}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.copy} onClick={copy}>
          {copied ? "Copied ✓" : "Copy link"}
        </button>
        {waText && (
          <a className={styles.wa} href={waLink(waText, waTo)} target="_blank" rel="noreferrer" onClick={onWhatsApp}>
            <WaIcon /> {waLabel}
          </a>
        )}
      </div>
    </div>
  );
}

export const WaIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="none">
    <path d="M4 20l1.3-3.9A8 8 0 1 1 8 18.8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 8.5c0 3 2.5 6 6 6.5l1-1.6-2-1-1 .8c-1-.5-2-1.5-2.4-2.4l.8-1-1-2z" fill="currentColor" />
  </svg>
);
