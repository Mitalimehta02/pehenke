"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Button, ChatMessage, Outgoing } from "@/lib/engine/types";
import { resizeForUpload } from "@/lib/client/resizeImage";
import styles from "./chat.module.css";

type State = string;
interface ApiReply {
  messages: ChatMessage[];
  state: State;
  error?: string;
}

/** Conversation states in which results arrive later, so the UI polls. */
const POLL_STATES = new Set(["TRYON_RUNNING", "AWAIT_SELLER"]);
const media = (key: string) => `/api/media/${key}`;

export default function ChatApp({ sellerSlug, sellerName }: { sellerSlug: string; sellerName: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<State>("NEW");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [localPhotos, setLocalPhotos] = useState<Record<string, string>>({});
  const [viewer, setViewer] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastId = messages.length ? messages[messages.length - 1].id : undefined;

  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
    });
  }, []);

  const post = useCallback(
    async (form: FormData): Promise<ApiReply | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/chat/${sellerSlug}`, { method: "POST", body: form });
        const data: ApiReply = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Something went wrong");
        merge(data.messages);
        setState(data.state);
        return data;
      } catch (e) {
        setError((e as Error).message || "Network problem. Please try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [sellerSlug, merge],
  );

  // Load history; greet a brand-new conversation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/chat/${sellerSlug}`);
      const data: ApiReply = await res.json();
      if (cancelled) return;
      merge(data.messages);
      setState(data.state);
      if (!data.messages.length) {
        const f = new FormData();
        f.set("kind", "open");
        await post(f);
      }
    })().catch(() => setError("Couldn't load the chat. Please refresh."));
    return () => {
      cancelled = true;
    };
  }, [sellerSlug, merge, post]);

  // Poll while a result is on its way (render running, seller deciding).
  useEffect(() => {
    if (!POLL_STATES.has(state)) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/${sellerSlug}/events${lastId ? `?after=${lastId}` : ""}`);
        const data: ApiReply = await res.json();
        merge(data.messages);
        setState(data.state);
      } catch {
        /* next tick */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [state, sellerSlug, lastId, merge]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy, state]);

  const sendText = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    const f = new FormData();
    f.set("kind", "text");
    f.set("text", t);
    await post(f);
  };

  const tap = async (b: Button) => {
    if (busy) return;
    const f = new FormData();
    f.set("kind", "button");
    f.set("id", b.id);
    f.set("label", b.label);
    await post(f);
  };

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const blob = await resizeForUpload(file);
    const f = new FormData();
    f.set("kind", "image");
    f.set("file", blob, "photo.jpg");
    const data = await post(f);
    const mine = data?.messages.find((m) => m.direction === "in");
    if (mine) setLocalPhotos((p) => ({ ...p, [mine.id]: URL.createObjectURL(blob) }));
    if (fileRef.current) fileRef.current.value = "";
  };

  // Only the newest message's buttons/choices are active; older ones are history.
  const lastOutWithActions = [...messages].reverse().find((m) => {
    const b = m.body as Outgoing;
    return m.direction === "out" && (("buttons" in b && b.buttons?.length) || b.kind === "choices");
  })?.id;
  const working = busy || state === "TRYON_RUNNING";

  return (
    <div className={styles.stage}>
      <main className={styles.phone}>
        <header className={styles.header}>
          <div className={styles.avatar} aria-hidden>
            {sellerName.slice(0, 1).toUpperCase()}
          </div>
          <div className={styles.headText}>
            <h1>{sellerName}</h1>
            <p>{state === "TRYON_RUNNING" ? "making your preview…" : "Try it on before you buy"}</p>
          </div>
        </header>

        <div className={styles.list} ref={listRef} aria-live="polite">
          {messages.map((m) => (
            <Message
              key={m.id}
              m={m}
              active={m.id === lastOutWithActions && !busy}
              localPhoto={localPhotos[m.id]}
              onTap={tap}
              onOpen={setViewer}
            />
          ))}
          {working && (
            <div className={`${styles.row} ${styles.left}`}>
              <div className={`${styles.bubble} ${styles.typing}`} aria-label="typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </div>

        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void sendText();
          }}
        >
          <button type="button" className={styles.attach} onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Send a photo">
            <CameraIcon />
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
          <input
            className={styles.input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message"
            enterKeyHint="send"
            aria-label="Message"
          />
          <button type="submit" className={styles.send} disabled={busy || !text.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </form>
      </main>

      {viewer && (
        <button className={styles.viewer} onClick={() => setViewer(null)} aria-label="Close image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewer} alt="" />
        </button>
      )}
    </div>
  );
}

function Message({
  m,
  active,
  localPhoto,
  onTap,
  onOpen,
}: {
  m: ChatMessage;
  active: boolean;
  localPhoto?: string;
  onTap: (b: Button) => void;
  onOpen: (src: string) => void;
}) {
  const b = m.body;
  if (m.direction === "in") {
    const text = "text" in b ? b.text : "";
    return (
      <div className={`${styles.row} ${styles.right}`}>
        <div className={`${styles.bubble} ${styles.mine}`}>
          {localPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.myPhoto} src={localPhoto} alt="Your photo" />
          ) : (
            text
          )}
        </div>
      </div>
    );
  }

  const o = b as Outgoing;
  if (o.kind === "status") return null;
  if (o.kind === "link") {
    return (
      <div className={`${styles.row} ${styles.left}`}>
        <a className={styles.demoLink} href={o.href} target="_blank" rel="noreferrer">
          {o.label} ↗
        </a>
      </div>
    );
  }

  const buttons = "buttons" in o ? o.buttons : undefined;
  return (
    <div className={`${styles.row} ${styles.left}`}>
      <div className={styles.stack}>
        {o.kind === "text" && <div className={`${styles.bubble} ${styles.theirs}`}>{o.text}</div>}

        {o.kind === "image" && (
          <div className={`${styles.bubble} ${styles.theirs} ${styles.media}`}>
            <button className={styles.imgBtn} onClick={() => onOpen(media(o.mediaKey))} aria-label="Open preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={media(o.mediaKey)} alt="Your try-on preview" />
            </button>
            {o.caption && <p className={styles.caption}>{o.caption}</p>}
          </div>
        )}

        {o.kind === "choices" && (
          <>
            <div className={`${styles.bubble} ${styles.theirs}`}>{o.text}</div>
            <div className={styles.choices}>
              {o.choices.map((c) => (
                <button key={c.id} className={styles.choice} disabled={!active} onClick={() => onTap({ id: c.id, label: c.label })}>
                  {c.mediaKey && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={media(c.mediaKey)} alt="" />
                  )}
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {o.kind === "card" && (
          <div className={styles.card}>
            {o.mediaKey ? (
              <button className={styles.imgBtn} onClick={() => onOpen(media(o.mediaKey!))} aria-label="Open order image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={media(o.mediaKey)} alt="What you ordered, on you" />
              </button>
            ) : (
              <div className={styles.cardNoImg}>Photo deleted</div>
            )}
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>
                <CheckIcon /> {o.title}
              </div>
              {o.lines.map((l, i) => (
                <p key={i} className={i === o.lines.length - 1 && o.lines.length > 2 ? styles.cardNote : undefined}>
                  {l}
                </p>
              ))}
            </div>
          </div>
        )}

        {buttons && buttons.length > 0 && (
          <div className={styles.replies}>
            {buttons.map((btn) => (
              <button key={btn.id} className={styles.reply} disabled={!active} onClick={() => onTap(btn)}>
                {btn.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const CameraIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);
const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor" />
  </svg>
);
const CheckIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
