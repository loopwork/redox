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
export function buildEditorExtensions(provider: WebsocketProvider) {
  return [
    ...buildContentExtensions(),
    new AnnotationExtension<MyAnnotation>({}),
    new YjsExtension({
      getProvider: () => provider,
      destroyProvider: () => undefined,
    }),
  ];
}
