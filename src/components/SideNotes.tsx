import { useLayoutEffect, useRef, useState } from "react";
import { useCommands, useHelpers, useRemirrorContext } from "@remirror/react";
import { getLocalUser } from "../collab";
import type { AnnotationReply, MyAnnotation } from "../annotations/types";

const GAP = 10; // vertical space between stacked cards
const HEAD = 30; // reserved space at the top for the panel header

// --- small presentational helpers -----------------------------------------
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

// Stable color per author name (so collaborators get consistent avatars).
const AVATAR_COLORS = [
  "#f97316",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#eab308",
];
const colorFor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
};

const relTime = (ts?: number): string => {
  if (!ts) return "just now";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// One-line reply composer for an annotation's conversation thread.
const ReplyComposer: React.FC<{ onSend: (text: string) => void }> = ({
  onSend,
}) => {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="note-reply">
      <input
        value={text}
        placeholder="Reply or add follow-up…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="note-reply-send" title="Send" onClick={send}>
        ↑
      </button>
    </div>
  );
};

// Margin panel: one card per annotation. Like Google Docs comments, each card
// sits next to the text it annotates — vertically aligned to the highlight —
// and cards cascade down only when they would otherwise overlap. Each card is a
// small thread: author, the linked selection, a note, and follow-up replies.
export const SideNotes: React.FC = () => {
  const { updateAnnotation, removeAnnotations } = useCommands();
  const { getAnnotations } = useHelpers(true);
  // autoUpdate re-renders on every editor transaction, so positions track edits.
  const { view } = useRemirrorContext({ autoUpdate: true });
  const annotations = getAnnotations() as MyAnnotation[];
  const me = getLocalUser();

  const railRef = useRef<HTMLElement>(null);
  const cardRefs = useRef(new Map<string, HTMLLIElement>());

  // Append a reply to an annotation's thread (merge-updates the annotation).
  const addReply = (a: MyAnnotation, text: string) => {
    const reply: AnnotationReply = {
      id: crypto.randomUUID(),
      author: me.name,
      text,
      createdAt: Date.now(),
    };
    updateAnnotation(a.id, {
      replies: [...(a.replies ?? []), reply],
    } as Parameters<typeof updateAnnotation>[1]);
  };

  // Scroll the editor so the annotated text is centered (Jump to selection).
  const jumpTo = (from: number) => {
    try {
      const { node } = view.domAtPos(from);
      const el = node instanceof Element ? node : node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      /* position not resolvable */
    }
  };

  // Pure layout sync (no React state): position each card next to its highlight
  // by writing `top` straight onto the DOM node. Runs after every render.
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const railTop = rail.getBoundingClientRect().top;
    const targets = annotations
      .map((a) => {
        let y = HEAD;
        try {
          y = view.coordsAtPos(a.from).top - railTop;
        } catch {
          /* position not resolvable yet */
        }
        return { id: a.id, target: Math.max(HEAD, y) };
      })
      .sort((p, q) => p.target - q.target);

    let cursor = HEAD;
    for (const t of targets) {
      const card = cardRefs.current.get(t.id);
      if (!card) continue;
      const top = Math.max(t.target, cursor);
      card.style.top = `${top}px`;
      cursor = top + card.offsetHeight + GAP;
    }
  });

  return (
    <aside className="side-notes" ref={railRef}>
      <div className="side-notes-head">
        <span className="side-notes-label">Annotations</span>
        <span className="side-notes-count">{annotations.length}</span>
      </div>
      {annotations.length === 0 ? (
        <p className="side-notes-empty">
          No annotations yet. Select text and pick a color.
        </p>
      ) : (
        <ul className="note-list">
          {annotations.map((a) => {
            const author = a.author ?? "You";
            return (
              <li
                key={a.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(a.id, el);
                  else cardRefs.current.delete(a.id);
                }}
                className={`note ${a.className ?? ""}`}
              >
                <div className="note-head">
                  <span
                    className="note-avatar"
                    style={{ background: colorFor(author) }}
                  >
                    {initials(author)}
                  </span>
                  <span className="note-author">{author}</span>
                  <span className="note-time">{relTime(a.createdAt)}</span>
                  <button
                    className="note-remove"
                    title="Delete annotation"
                    onClick={() => removeAnnotations([a.id])}
                  >
                    ✕
                  </button>
                </div>

                <button
                  className="note-quote"
                  title="Jump to selection"
                  onClick={() => jumpTo(a.from)}
                >
                  “{a.text || "(empty)"}”
                </button>

                <div className="note-type" role="group" aria-label="Note type">
                  <button className="note-type-btn active">Note</button>
                  <button className="note-type-btn" disabled title="Coming soon">
                    Voice
                  </button>
                  <button className="note-type-btn" disabled title="Coming soon">
                    Task
                  </button>
                </div>

                <textarea
                  className="note-text"
                  defaultValue={a.comment ?? ""}
                  placeholder="Add a note…"
                  rows={2}
                  onBlur={(e) =>
                    updateAnnotation(a.id, {
                      comment: e.target.value,
                    } as Parameters<typeof updateAnnotation>[1])
                  }
                />

                {(a.replies?.length ?? 0) > 0 && (
                  <ul className="note-thread">
                    {a.replies!.map((r) => (
                      <li key={r.id} className="note-thread-item">
                        <span
                          className="note-avatar sm"
                          style={{ background: colorFor(r.author) }}
                        >
                          {initials(r.author)}
                        </span>
                        <div className="note-thread-body">
                          <div className="note-thread-meta">
                            <span className="note-author">{r.author}</span>
                            <span className="note-time">
                              {relTime(r.createdAt)}
                            </span>
                          </div>
                          <p className="note-thread-text">{r.text}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <ReplyComposer onSend={(t) => addReply(a, t)} />
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};
