import { useEffect } from "react";
import {
  Remirror,
  ThemeProvider,
  EditorComponent,
  useRemirror,
} from "@remirror/react";
import type { Doc } from "yjs";
import {
  acquireRoom,
  docRoom,
  getLocalUser,
  getRoom,
  releaseRoom,
  type FileMeta,
} from "../collab";
import { buildEditorExtensions } from "../editor/extensions";
import { useAnnotationSync } from "../annotations/useAnnotationSync";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { SideNotes } from "./SideNotes";
import { TopBar } from "./TopBar";

// Mount point for the annotation <-> Yjs sync. The logic lives in the hook; this
// runs it inside the Remirror provider.
const AnnotationSync: React.FC<{ doc: Doc }> = ({ doc }) => {
  useAnnotationSync(doc);
  return null;
};

// Editor for a single file. The `key={file.id}` on the parent guarantees a fresh
// mount (new manager + room connection) per file.
export const FileEditor: React.FC<{ file: FileMeta }> = ({ file }) => {
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
    extensions: () => buildEditorExtensions(conn.provider),
  });

  return (
    <div className="editor-wrap">
      <ThemeProvider>
        <Remirror manager={manager} initialContent={state}>
          <TopBar name={file.name} />
          <AnnotationToolbar />
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
