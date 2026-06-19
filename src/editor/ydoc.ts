import * as Y from "yjs";
import {
  prosemirrorJSONToYDoc,
  yDocToProsemirrorJSON,
} from "y-prosemirror";
import { getSchema } from "./schema";
import {
  markdownToProsemirrorJSON,
  prosemirrorJSONToMarkdown,
} from "./markdown";

// Bridge between on-disk markdown and the live Yjs document used by the editor.
//
// y-prosemirror stores ProseMirror content in a Y.XmlFragment whose default key
// is "prosemirror" (matching the client's YjsExtension config). These helpers go
// markdown <-> ProseMirror JSON <-> Y.Doc using that same fragment, so a Y.Doc
// seeded here is byte-compatible with what the browser editor expects.

// The XmlFragment key y-prosemirror uses by default (and that the client relies
// on). Centralized here so server code never hard-codes the literal.
export const PM_FRAGMENT = "prosemirror";

/**
 * Build a fresh Y.Doc whose "prosemirror" XmlFragment is seeded from markdown.
 * Used on cold-load when a document room is first opened from disk.
 */
export function markdownToYDoc(md: string): Y.Doc {
  const schema = getSchema();
  const json = markdownToProsemirrorJSON(md);
  // prosemirrorJSONToYDoc builds a new Y.Doc with the content under PM_FRAGMENT.
  return prosemirrorJSONToYDoc(schema, json, PM_FRAGMENT);
}

/**
 * Apply markdown content into an EXISTING Y.Doc's "prosemirror" fragment.
 * Mirrors markdownToYDoc but writes into a caller-owned doc (e.g. the live
 * WSSharedDoc) inside a transaction, so the seed is a single update.
 */
export function seedYDocFromMarkdown(
  target: Y.Doc,
  md: string,
  origin?: unknown,
): void {
  const seeded = markdownToYDoc(md);
  const update = Y.encodeStateAsUpdate(seeded);
  Y.applyUpdate(target, update, origin);
}

/**
 * Serialize a Y.Doc's "prosemirror" XmlFragment back to markdown.
 * Used on flush to write the live session state to disk.
 */
export function yDocToMarkdown(doc: Y.Doc): string {
  const json = yDocToProsemirrorJSON(doc, PM_FRAGMENT);
  return prosemirrorJSONToMarkdown(json as Record<string, unknown>);
}
