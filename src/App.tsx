import { useCallback, useState } from "react";
import type { RemirrorJSON } from "remirror";
import { wysiwygPreset } from "remirror/extensions";
import { AnnotationExtension } from "remirror/extensions";
import {
  Remirror,
  ThemeProvider,
  EditorComponent,
  OnChangeJSON,
  useRemirror,
  useCommands,
  useHelpers,
  useRemirrorContext,
} from "@remirror/react";
import "@remirror/styles/all.css";
import "./annotations.css";

const STORAGE_KEY = "remirror-editor-content";

// Color choices applied to annotations via the `className` field. The
// AnnotationExtension renders annotations as decorations, so a single
// annotation can span multiple nodes (unlike marks).
const COLORS = [
  { label: "Yellow", className: "annotation-yellow" },
  { label: "Green", className: "annotation-green" },
  { label: "Pink", className: "annotation-pink" },
] as const;

const App: React.FC = () => {
  const [initialContent] = useState<RemirrorJSON | undefined>(() => {
    const content = window.localStorage.getItem(STORAGE_KEY);
    return content ? JSON.parse(content) : undefined;
  });

  const handleEditorChange = useCallback((json: RemirrorJSON) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
  }, []);

  return (
    <MyEditor onChange={handleEditorChange} initialContent={initialContent} />
  );
};

interface MyEditorProps {
  onChange: (json: RemirrorJSON) => void;
  initialContent?: RemirrorJSON;
}

const MyEditor: React.FC<MyEditorProps> = ({ onChange, initialContent }) => {
  const { manager, state } = useRemirror({
    extensions: () => [...wysiwygPreset({}), new AnnotationExtension({})],
    content: initialContent,
    stringHandler: "html",
    selection: "end",
  });

  return (
    <div style={{ padding: 16 }}>
      <ThemeProvider>
        <Remirror manager={manager} initialContent={state}>
          <AnnotationControls />
          <EditorComponent />
          <AnnotationList />
          <OnChangeJSON onChange={onChange} />
        </Remirror>
      </ThemeProvider>
    </div>
  );
};

// Toolbar: add an annotation over the current selection, optionally colored.
const AnnotationControls: React.FC = () => {
  const commands = useCommands();
  // autoUpdate keeps the selection in sync so the buttons enable/disable live.
  const { view } = useRemirrorContext({ autoUpdate: true });
  const { empty } = view.state.selection;

  const annotate = (className?: string) => {
    commands.addAnnotation({ id: crypto.randomUUID(), className });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginBottom: 8,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, color: "#666" }}>
        Select text, then annotate:
      </span>
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

// Panel listing every annotation in the document, with remove controls.
const AnnotationList: React.FC = () => {
  const commands = useCommands();
  // `true` => re-render on every editor state change so the list stays fresh.
  const { getAnnotations } = useHelpers(true);
  const annotations = getAnnotations();

  if (annotations.length === 0) {
    return (
      <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
        No annotations yet.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>Annotations ({annotations.length})</strong>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
        {annotations.map((a) => (
          <li
            key={a.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "4px 0",
            }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 13,
              }}
            >
              [{a.from}–{a.to}] {a.text || "(empty)"}
            </span>
            <button onClick={() => commands.removeAnnotations([a.id])}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default App;
