import { useCommands, useRemirrorContext } from "@remirror/react";
import { getLocalUser } from "../collab";

// Highlight colors. Every annotation is one of these; lavender is the default.
const COLORS = [
  { label: "Lavender", className: "annotation-lavender" },
  { label: "Yellow", className: "annotation-yellow" },
  { label: "Green", className: "annotation-green" },
  { label: "Pink", className: "annotation-pink" },
] as const;

// Toolbar above the document: highlight the current selection in a color. Each
// new highlight is stamped with the local author + time for the side panel.
export const AnnotationToolbar: React.FC = () => {
  const { addAnnotation } = useCommands();
  const { view } = useRemirrorContext({ autoUpdate: true });
  const { empty } = view.state.selection;
  const user = getLocalUser();

  return (
    <div className="annotate-bar">
      <span className="annotate-label">Highlight</span>
      <div className="color-dots">
        {COLORS.map((c) => (
          <button
            key={c.className}
            className={`color-dot ${c.className}`}
            title={c.label}
            disabled={empty}
            onClick={() =>
              addAnnotation({
                id: crypto.randomUUID(),
                className: c.className,
                author: user.name,
                createdAt: Date.now(),
              } as Parameters<typeof addAnnotation>[0])
            }
          />
        ))}
      </div>
      <span className="annotate-hint">
        {empty ? "select text to annotate" : "pick a color"}
      </span>
    </div>
  );
};
