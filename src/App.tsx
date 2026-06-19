import { useEffect, useState } from "react";
import { wysiwygPreset, MarkdownExtension } from "remirror/extensions";
import {
  AnnotationExtension,
  type Annotation,
} from "@remirror/extension-annotation";
import {
  Remirror,
  ThemeProvider,
  EditorComponent,
  useRemirror,
  useCommands,
  useHelpers,
  useRemirrorContext,
} from "@remirror/react";
import "@remirror/styles/all.css";
import "./annotations.css";

// Markdown source of the document and the annotation overlay are stored
// separately: markdown has nowhere to encode annotation ranges/comments, so
// annotations are persisted as their own positional array and re-applied on
// load via `setAnnotations`.
const MARKDOWN_KEY = "remirror-markdown";
const ANNOTATIONS_KEY = "remirror-annotations";

const DEFAULT_MARKDOWN = `# Annotated notes

Select any text, click **Annotate**, then add a side note in the panel on the
right. Annotations are decorations, so a single note can span *multiple* nodes.
`;

// Extend the base Annotation with our own fields. AnnotationExtension is
// generic over this type, so commands/helpers carry \`comment\` through.
interface MyAnnotation extends Annotation {
  className?: string;
  comment?: string;
}

const COLORS = [
  { label: "Yellow", className: "annotation-yellow" },
  { label: "Green", className: "annotation-green" },
  { label: "Pink", className: "annotation-pink" },
] as const;

const App: React.FC = () => {
  const [initialMarkdown] = useState<string>(
    () => window.localStorage.getItem(MARKDOWN_KEY) ?? DEFAULT_MARKDOWN,
  );

  return <MyEditor initialMarkdown={initialMarkdown} />;
};

interface MyEditorProps {
  initialMarkdown: string;
}

const MyEditor: React.FC<MyEditorProps> = ({ initialMarkdown }) => {
  const { manager, state } = useRemirror({
    extensions: () => [
      ...wysiwygPreset({}),
      new MarkdownExtension({ copyAsMarkdown: false }),
      new AnnotationExtension<MyAnnotation>({}),
    ],
    content: initialMarkdown,
    stringHandler: "markdown",
    selection: "end",
  });

  return (
    <div style={{ padding: 16 }}>
      <ThemeProvider>
        <Remirror manager={manager} initialContent={state}>
          <AnnotationControls />
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            <div style={{ flex: 2, minWidth: 0 }}>
              <EditorComponent />
            </div>
            <SideNotes />
          </div>
          <RestoreAnnotations />
          <Persist />
        </Remirror>
      </ThemeProvider>
    </div>
  );
};

// Re-apply persisted annotations once, after the initial document is mounted.
const RestoreAnnotations: React.FC = () => {
  const { setAnnotations } = useCommands();

  useEffect(() => {
    const raw = window.localStorage.getItem(ANNOTATIONS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as MyAnnotation[];
    if (saved.length === 0) return;
    // `setAnnotations` wants the positional shape without `text` (it is
    // recomputed from the document). The cast carries our custom `comment`
    // field, which the base-typed command signature doesn't know about.
    setAnnotations(
      saved.map((a) => ({
        id: a.id,
        from: a.from,
        to: a.to,
        className: a.className,
        comment: a.comment,
      })) as Parameters<typeof setAnnotations>[0],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
};

// Persist markdown + annotations on every editor update. `useHelpers(true)`
// re-renders this component whenever the editor state changes.
const Persist: React.FC = () => {
  const { getMarkdown, getAnnotations } = useHelpers(true);

  useEffect(() => {
    window.localStorage.setItem(MARKDOWN_KEY, getMarkdown());
    window.localStorage.setItem(
      ANNOTATIONS_KEY,
      JSON.stringify(getAnnotations()),
    );
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
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginBottom: 12,
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

// Margin panel: one card per annotation with an editable side note.
const SideNotes: React.FC = () => {
  const { updateAnnotation, removeAnnotations } = useCommands();
  const { getAnnotations } = useHelpers(true);
  const annotations = getAnnotations() as MyAnnotation[];

  return (
    <aside
      style={{
        flex: 1,
        minWidth: 240,
        maxWidth: 320,
        borderLeft: "1px solid #eee",
        paddingLeft: 12,
      }}
    >
      <strong style={{ fontSize: 13 }}>
        Side notes ({annotations.length})
      </strong>
      {annotations.length === 0 ? (
        <p style={{ color: "#999", fontSize: 13 }}>
          No annotations yet. Select text and annotate.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
          {annotations.map((a) => (
            <li
              key={a.id}
              className={a.className}
              style={{
                padding: 8,
                marginBottom: 8,
                borderRadius: 4,
                border: "1px solid #e0e0e0",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: "#555",
                  fontStyle: "italic",
                  marginBottom: 6,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                “{a.text || "(empty)"}”
              </div>
              <textarea
                defaultValue={a.comment ?? ""}
                placeholder="Add a note…"
                rows={2}
                style={{ width: "100%", boxSizing: "border-box", fontSize: 13 }}
                onBlur={(e) =>
                  // Preserve className when writing the comment back. Cast
                  // carries `comment` past the base-typed command signature.
                  updateAnnotation(a.id, {
                    className: a.className,
                    comment: e.target.value,
                  } as Parameters<typeof updateAnnotation>[1])
                }
              />
              <button
                style={{ marginTop: 4, fontSize: 12 }}
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
