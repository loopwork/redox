import { wysiwygPreset, MarkdownExtension } from "remirror/extensions";
import { AnnotationExtension } from "@remirror/extension-annotation";
import { YjsExtension } from "@remirror/extension-yjs";
import type { WebsocketProvider } from "y-websocket";
import type { MyAnnotation } from "../annotations/types";

// The editor's extension stack for a single file. Yjs owns document content +
// history; the provider lifecycle is managed externally (refcounted rooms), so
// the extension must not destroy it.
export function buildEditorExtensions(provider: WebsocketProvider) {
  return [
    ...wysiwygPreset({}),
    new MarkdownExtension({ copyAsMarkdown: false }),
    new AnnotationExtension<MyAnnotation>({}),
    new YjsExtension({
      getProvider: () => provider,
      destroyProvider: () => undefined,
    }),
  ];
}
