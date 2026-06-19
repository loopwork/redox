import { useEffect, useRef, useState } from "react";
import { wysiwygPreset, MarkdownExtension } from "remirror/extensions";
import {
  AnnotationExtension,
  type Annotation,
} from "@remirror/extension-annotation";
import { YjsExtension } from "@remirror/extension-yjs";
import {
  Remirror,
  ThemeProvider,
  EditorComponent,
  useRemirror,
  useCommands,
  useHelpers,
  useRemirrorContext,
} from "@remirror/react";
import * as Y from "yjs";
import "@remirror/styles/all.css";
import "./annotations.css";
import "./App.css";
import {
  acquireRoom,
  ANNOTATIONS_ARRAY,
  createFile,
  deleteFile,
  docRoom,
  getLocalUser,
  getRoom,
  LOCAL_ORIGIN,
  renameFile,
  releaseRoom,
  useFiles,
  type FileMeta,
} from "./collab";

// Extend the base Annotation with our own fields. AnnotationExtension is
// generic over this type, so commands/helpers carry `comment` through.
interface MyAnnotation extends Annotation {
  className?: string;
  comment?: string;
}

// Positional shape we persist into Yjs (text is recomputed from the document).
interface StoredAnnotation {
  id: string;
  from: number;
  to: number;
  className?: string;
  comment?: string;
}

const COLORS = [
  { label: "Yellow", className: "annotation-yellow" },
  { label: "Green", className: "annotation-green" },
  { label: "Pink", className: "annotation-pink" },
] as const;

// --- Active file, stored in the URL hash so collab links are shareable -----

function useActiveFileId(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(
    () => window.location.hash.slice(1) || null,
  );
  useEffect(() => {
    const onHash = () => setId(window.location.hash.slice(1) || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = (next: string) => {
    window.location.hash = next;
  };
  return [id, select];
}

const App: React.FC = () => {
  const files = useFiles();
  const [activeId, setActiveId] = useActiveFileId();

  // Fall back to the first file when the hash points nowhere valid.
  const active = files.find((f) => f.id === activeId) ?? null;

  return (
    <div className="layout">
      <Sidebar files={files} activeId={active?.id ?? null} onSelect={setActiveId} />
      <main className="content">
        {active ? (
          // key forces a clean remount (new manager + room) per file.
          <FileEditor key={active.id} file={active} />
        ) : (
          <EmptyState
            hasFiles={files.length > 0}
            onCreate={() => setActiveId(createFile("Untitled").id)}
          />
        )}
      </main>
    </div>
  );
};

// --- Sidebar: file list + create/rename/delete -----------------------------

interface SidebarProps {
  files: FileMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ files, activeId, onSelect }) => {
  const user = getLocalUser();
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <strong>Files</strong>
        <button onClick={() => onSelect(createFile("Untitled").id)}>+ New</button>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <li
            key={f.id}
            className={f.id === activeId ? "file active" : "file"}
            onClick={() => onSelect(f.id)}
          >
            <span className="file-name" title={f.name}>
              {f.name}
            </span>
            <span className="file-actions">
              <button
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  const name = window.prompt("Rename file", f.name);
                  if (name != null) renameFile(f.id, name);
                }}
              >
                ✎
              </button>
              <button
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${f.name}"?`)) deleteFile(f.id);
                }}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
        {files.length === 0 && <li className="file-empty">No files yet.</li>}
      </ul>
      <div className="sidebar-foot">
        <span className="user-dot" style={{ background: user.color }} />
        {user.name}
      </div>
    </aside>
  );
};

const EmptyState: React.FC<{ hasFiles: boolean; onCreate: () => void }> = ({
  hasFiles,
  onCreate,
}) => (
  <div className="empty-state">
    <p>{hasFiles ? "Select a file from the left." : "No files yet."}</p>
    <button onClick={onCreate}>Create a file</button>
  </div>
);

// --- Editor for a single file ----------------------------------------------

const FileEditor: React.FC<{ file: FileMeta }> = ({ file }) => {
  const room = docRoom(file.id);
  // Idempotent on every render; the ref lifecycle is handled in the effect.
  const conn = getRoom(room);

  useEffect(() => {
    acquireRoom(room);
    conn.provider.awareness.setLocalStateField("user", getLocalUser());
    return () => releaseRoom(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  const { manager, state } = useRemirror({
    extensions: () => [
      ...wysiwygPreset({}),
      new MarkdownExtension({ copyAsMarkdown: false }),
      new AnnotationExtension<MyAnnotation>({}),
      // Yjs owns document content + history. We manage the provider lifecycle
      // ourselves (refcounted), so the extension must not destroy it.
      new YjsExtension({
        getProvider: () => conn.provider,
        destroyProvider: () => undefined,
      }),
    ],
  });

  return (
    <div className="editor-wrap">
      <ThemeProvider>
        <Remirror manager={manager} initialContent={state}>
          <h2 className="doc-title">{file.name}</h2>
          <AnnotationControls />
          <div className="editor-row">
            <div className="editor-main">
              <EditorComponent />
            </div>
            <SideNotes />
          </div>
          <AnnotationSync doc={conn.doc} />
        </Remirror>
      </ThemeProvider>
    </div>
  );
};

// Order-independent serialization of an annotation set, for change detection.
const normalize = (xs: StoredAnnotation[]) =>
  JSON.stringify(
    [...xs]
      .map((a) => ({
        id: a.id,
        from: a.from,
        to: a.to,
        className: a.className,
        comment: a.comment,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

// Two-way sync of annotations through the file's Yjs document. The two
// directions use different mechanisms on purpose:
//
//   Yjs -> editor (READ): a reactive effect. Annotation ranges only resolve
//     once the Yjs content has rendered into the editor (content size > 2 ==
//     more than one empty paragraph), since y-prosemirror applies remote
//     content a tick after the Yjs update. Running setAnnotations from an effect
//     (not from within an update listener) dispatches a clean transaction, so
//     dependents like SideNotes re-render.
//
//   editor -> Yjs (WRITE): an imperative update listener that reads FRESH state.
//     A render-captured snapshot can be stale exactly when content arrives, so
//     reading via the listener's `helpers` avoids clobbering stored data. The
//     `restored` guard ensures we never write the empty pre-restore state.
//
// Positions are absolute; under simultaneous edits they self-heal on convergence.
const AnnotationSync: React.FC<{ doc: Y.Doc }> = ({ doc }) => {
  const { setAnnotations } = useCommands();
  const { view } = useRemirrorContext({ autoUpdate: true });
  const contentReady = view.state.doc.content.size > 2;
  const restored = useRef(false);
  // Bumped by remote (non-local) changes to re-run the read effect.
  const [remoteRev, setRemoteRev] = useState(0);
  // Serialized value of the last set we read from or wrote to Yjs. Both
  // directions compare against this so a stable state never re-syncs — which is
  // what keeps the editor<->Yjs binding from feeding back on itself.
  const lastSynced = useRef<string>("");

  // READ: mirror stored annotations into the editor once content is ready, and
  // again whenever a remote peer changes them.
  useEffect(() => {
    if (!contentReady) return;
    const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
    const stored = arr.toArray();
    lastSynced.current = normalize(stored);
    setAnnotations(
      stored.map((a) => ({
        id: a.id,
        from: a.from,
        to: a.to,
        className: a.className,
        comment: a.comment,
      })) as Parameters<typeof setAnnotations>[0],
    );
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentReady, remoteRev]);

  useEffect(() => {
    const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
    const observer = (e: Y.YArrayEvent<StoredAnnotation>) => {
      if (e.transaction.origin === LOCAL_ORIGIN) return; // ignore our echoes
      setRemoteRev((v) => v + 1);
    };
    arr.observe(observer);
    return () => arr.unobserve(observer);
  }, [doc]);

  // WRITE: on every editor update, read fresh annotations and push changes.
  // Deferred to a microtask so the Yjs write happens OUTSIDE ProseMirror's
  // dispatch stack — y-prosemirror re-dispatches editor transactions on doc
  // updates, and writing inline would recurse. The lastSynced guard then stops
  // a stable state from looping.
  useRemirrorContext((props) => {
    if (!restored.current) return; // wait for the initial restore
    const fresh = props.helpers.getAnnotations() as MyAnnotation[];
    const next: StoredAnnotation[] = fresh.map((a) => ({
      id: a.id,
      from: a.from,
      to: a.to,
      className: a.className,
      comment: a.comment,
    }));
    const ser = normalize(next);
    if (ser === lastSynced.current) return; // unchanged since last sync
    lastSynced.current = ser;
    queueMicrotask(() => {
      const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
      if (normalize(arr.toArray()) === ser) return;
      doc.transact(() => {
        arr.delete(0, arr.length);
        arr.insert(0, next);
      }, LOCAL_ORIGIN);
    });
  });

  return null;
};

// Toolbar: annotate the current selection (plain or colored).
const AnnotationControls: React.FC = () => {
  const { addAnnotation } = useCommands();
  const { view } = useRemirrorContext({ autoUpdate: true });
  const { empty } = view.state.selection;

  const annotate = (className?: string) => {
    addAnnotation({ id: crypto.randomUUID(), className });
  };

  return (
    <div className="annotate-bar">
      <span className="hint">Select text, then annotate:</span>
      <button disabled={empty} onClick={() => annotate()}>
        Annotate
      </button>
      {COLORS.map((c) => (
        <button
          key={c.className}
          disabled={empty}
          onClick={() => annotate(c.className)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
};

// Margin panel: one card per annotation with an editable side note.
const SideNotes: React.FC = () => {
  const { updateAnnotation, removeAnnotations } = useCommands();
  const { getAnnotations } = useHelpers(true);
  const annotations = getAnnotations() as MyAnnotation[];

  return (
    <aside className="side-notes">
      <strong className="side-notes-head">
        Side notes ({annotations.length})
      </strong>
      {annotations.length === 0 ? (
        <p className="hint">No annotations yet. Select text and annotate.</p>
      ) : (
        <ul className="note-list">
          {annotations.map((a) => (
            <li key={a.id} className={`note ${a.className ?? ""}`}>
              <div className="note-quote">“{a.text || "(empty)"}”</div>
              <textarea
                defaultValue={a.comment ?? ""}
                placeholder="Add a note…"
                rows={2}
                onBlur={(e) =>
                  updateAnnotation(a.id, {
                    className: a.className,
                    comment: e.target.value,
                  } as Parameters<typeof updateAnnotation>[1])
                }
              />
              <button
                className="note-remove"
                onClick={() => removeAnnotations([a.id])}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};

export default App;
