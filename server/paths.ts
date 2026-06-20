// Store paths and file-id math (SERVER-ONLY). Pure path/string logic — no git,
// no Yjs, no filesystem mutation — so both store.ts and git.ts can depend on it
// without a cycle.
//
// A document's "id" is its store-relative path including the .md extension (e.g.
// "notes/architecture.md"); the room name is "redox:doc:<id>".
import path from "node:path";

// Name->id derivation is shared with the client (one definition, no drift).
export { nameToFileId, uniqueFileId } from "../src/shared/protocol";

// Store root: its own git repo. Configurable via REDOX_STORE_DIR (default
// ./store, resolved against the process cwd).
export const STORE_DIR = path.resolve(process.env.REDOX_STORE_DIR ?? "./store");

// Map a file id to its on-disk markdown path. The id already carries `.md`.
export function mdPathFor(id: string): string {
  return path.join(STORE_DIR, id);
}

// notes/x.md -> <store>/notes/x.annotations.json
export function annotationsPathFor(id: string): string {
  const base = id.endsWith(".md") ? id.slice(0, -".md".length) : id;
  return path.join(STORE_DIR, `${base}.annotations.json`);
}

// Guard against path traversal: the resolved file must stay under STORE_DIR.
export function assertInsideStore(p: string): void {
  const rel = path.relative(STORE_DIR, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to access path outside store: ${p}`);
  }
}

// Relative-to-store id (POSIX separators) for an absolute path under STORE_DIR.
export function toFileId(absPath: string): string {
  return path.relative(STORE_DIR, absPath).split(path.sep).join("/");
}

// True if `id` looks like a path-keyed file id (what the server publishes)
// rather than the client's UUID. UUIDs never end in ".md".
export function isFileId(id: string): boolean {
  return id.endsWith(".md");
}

