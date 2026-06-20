import type { Node as PMNode } from "@remirror/pm/model";
import { getSchema } from "./schema";
import { getParser } from "./markdown-parser";
import { getSerializer } from "./markdown-serializer";

// Markdown <-> ProseMirror bridge for the redox content schema. This module is
// the public API; the three concerns it composes live in their own files:
//   ./markdown-tokenizer  — the markdown-it instance (CommonMark + GFM + the
//                           underline/table-cell core rules)
//   ./markdown-parser     — markdown tokens -> ProseMirror (our schema names)
//   ./markdown-serializer — ProseMirror -> markdown
//
// We do NOT reuse prosemirror-markdown's default parser/serializer: those target
// the CommonMark demo schema whose node/mark names (bullet_list, strong, em, ...)
// differ from the remirror schema (bulletList, bold, italic, ...). We also avoid
// the remirror MarkdownExtension's own helpers: they go markdown -> HTML (marked)
// -> ProseMirror (DOMParser) and back via turndown, all of which require DOM
// globals that don't exist in headless Node. prosemirror-markdown + markdown-it
// run purely on strings, no DOM needed.

/** Parse markdown into a ProseMirror document JSON (using the redox schema). */
export function markdownToProsemirrorJSON(md: string): Record<string, unknown> {
  const doc = getParser().parse(md ?? "");
  return doc.toJSON() as Record<string, unknown>;
}

/** Serialize a ProseMirror document JSON back to markdown. */
export function prosemirrorJSONToMarkdown(json: Record<string, unknown>): string {
  const schema = getSchema();
  const doc = schema.nodeFromJSON(json);
  return getSerializer().serialize(doc, { tightLists: true });
}

/** Parse markdown into a ProseMirror document Node (using the redox schema). */
export function markdownToProsemirrorNode(md: string): PMNode {
  return getParser().parse(md ?? "");
}

/** Serialize a ProseMirror document Node back to markdown. */
export function prosemirrorNodeToMarkdown(doc: PMNode): string {
  return getSerializer().serialize(doc, { tightLists: true });
}
