import { useEffect, useState } from "react";
import { wysiwygPreset, MarkdownExtension } from "remirror/extensions";
import { AnnotationExtension } from "@remirror/extension-annotation";
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
import type { Doc } from "yjs";
import "@remirror/styles/all.css";
import "./annotations.css";
import "./App.css";
import {
  acquireRoom,
  createFile,
  deleteFile,
  docRoom,
  getLocalUser,
  getRoom,
  renameFile,
  releaseRoom,
  useFiles,
  type FileMeta,
} from "./collab";
import { useAnnotationSync } from "./annotations/useAnnotationSync";
import type { MyAnnotation } from "./annotations/types";

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

// Mount point for the annotation <-> Yjs sync. The logic lives in the hook; this
// component just runs it inside the Remirror provider.
const AnnotationSync: React.FC<{ doc: Doc }> = ({ doc }) => {
  useAnnotationSync(doc);
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
