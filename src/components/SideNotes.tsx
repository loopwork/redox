import { useCommands, useHelpers } from "@remirror/react";
import type { MyAnnotation } from "../annotations/types";

// Margin panel: one card per annotation with an editable side note.
export const SideNotes: React.FC = () => {
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
