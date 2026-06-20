import {
  wysiwygPreset,
  MarkdownExtension,
  TableExtension,
} from "remirror/extensions";

// The content/schema-defining extension stack, shared by the client editor and
// the headless server schema. This is the single source of truth for which
// rich-text nodes and marks exist in a document.
//
// IMPORTANT: this list deliberately excludes the React framework's core node
// extensions (Doc/Paragraph/Text), the AnnotationExtension, and the YjsExtension:
//   - On the client, `useRemirror`/`createReactManager` already injects the core
//     preset (Doc/Paragraph/Text + plugins), and the editor adds Annotation +
//     Yjs on top (see editor/extensions.ts). Keeping those out of this shared
//     list means the client's extension list is byte-for-byte what it was before
//     this module existed, so client behavior is unchanged.
//   - On the server (headless schema build), there is no React framework, so the
//     server adds Doc/Paragraph/Text itself before spreading this list. The
//     AnnotationExtension is a plugin-only concern (no schema impact) and the
//     YjsExtension needs a live provider, so neither belongs in a pure schema.
//
// Both consumers therefore derive the *same* set of content nodes/marks from
// here: headings, bold, italic, lists, blockquote, code block, links, etc.
export function buildContentExtensions() {
  return [
    ...wysiwygPreset({}),
    // Tables: adds the table/tableRow/tableCell/tableHeaderCell nodes. The
    // markdown bridge (editor/markdown.ts) round-trips these to GFM pipe tables.
    new TableExtension({}),
    new MarkdownExtension({ copyAsMarkdown: false }),
  ];
}
