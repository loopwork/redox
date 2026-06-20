import { AnnotationExtension } from "@remirror/extension-annotation";
import { YjsExtension } from "@remirror/extension-yjs";
import type { WebsocketProvider } from "y-websocket";
import type { MyAnnotation } from "../annotations/types";
import { buildContentExtensions } from "./contentExtensions";

// The editor's extension stack for a single file. Yjs owns document content +
// history; the provider lifecycle is managed externally (refcounted rooms), so
// the extension must not destroy it.
//
// The content nodes/marks come from the shared `buildContentExtensions()` (also
// used to build the headless server schema), so the two never drift. The result
// is identical to spreading `wysiwygPreset({})` + `MarkdownExtension(...)` here
// directly, as before — only the source of that sub-list moved.

// Highlight color for a plain (uncolored) annotation — the familiar lavender.
const PLAIN_ANNOTATION_STYLE = "background: rgba(120, 120, 255, 0.25);";

// Inline style for an annotation decoration segment. A *colored* annotation
// paints itself via its `.annotation-*` CSS class (the same class the side-note
// cards use), so we return no inline style and let that class background show in
// the editor — otherwise the extension's default inline lavender would override
// it and the editor would never reflect the chosen color. Plain annotations have
// no class, so they get the default highlight here.
const annotationStyle = (annotations: Array<MyAnnotation>): string | undefined =>
  annotations.some((a) => a.className) ? undefined : PLAIN_ANNOTATION_STYLE;

export function buildEditorExtensions(provider: WebsocketProvider) {
  return [
    ...buildContentExtensions(),
    new AnnotationExtension<MyAnnotation>({ getStyle: annotationStyle }),
    new YjsExtension({
      getProvider: () => provider,
      destroyProvider: () => undefined,
    }),
  ];
}
