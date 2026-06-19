import { useCommands, useRemirrorContext } from "@remirror/react";

const COLORS = [
  { label: "Yellow", className: "annotation-yellow" },
  { label: "Green", className: "annotation-green" },
  { label: "Pink", className: "annotation-pink" },
] as const;

// Toolbar: annotate the current selection (plain or colored).
export const AnnotationToolbar: React.FC = () => {
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
