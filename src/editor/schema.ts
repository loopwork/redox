import { RemirrorManager } from "@remirror/core";
import {
  DocExtension,
  ParagraphExtension,
  TextExtension,
} from "remirror/extensions";
import type { Schema } from "@remirror/pm/model";
import { buildContentExtensions } from "./contentExtensions";

// Build the ProseMirror schema headlessly (no React, no EditorView) from the
// SAME content extensions the client editor uses. This lets server-side code
// (markdown <-> ProseMirror <-> Yjs) operate on documents whose schema is
// guaranteed to match what the browser editor renders.
//
// Why the explicit Doc/Paragraph/Text extensions: on the client these come from
// the React framework's core preset, which is not present in a headless Node
// build. RemirrorManager.create() throws "Schema is missing its top node type
// ('doc')" without them. They define the structural backbone (doc > block,
// paragraph > inline, the text node) and carry no markdown-relevant options, so
// adding them here cannot change the rich content shape derived from the shared
// extensions.
//
// RemirrorManager.create() works in plain Node: it computes the schema eagerly
// in its constructor (via the builtin SchemaExtension) without ever needing the
// DOM or an EditorView. Only mounting an editor would require DOM globals.
export function buildSchema(): Schema {
  const manager = RemirrorManager.create([
    new DocExtension({}),
    new ParagraphExtension({}),
    new TextExtension({}),
    ...buildContentExtensions(),
  ]);
  return manager.schema as unknown as Schema;
}

// Lazily built, cached schema. Building it instantiates the whole extension
// stack, so we only do it once per process.
let cached: Schema | null = null;
export function getSchema(): Schema {
  if (cached === null) cached = buildSchema();
  return cached;
}
