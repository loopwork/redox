// Wire protocol shared by BOTH the client and the server. This module is
// deliberately DOM-free (no `window`, no `import.meta`) so the Node server can
// import it directly — the client and server must agree on these room names,
// Yjs shared-type keys, and metadata shapes, and centralizing them here removes
// the drift risk of hand-copied literals on each side.

// Room names (one room == one Yjs document on the server).
export const INDEX_ROOM = "redox:index"; // the shared file list
export const DOC_PREFIX = "redox:doc:"; // prefix for a file's content room

/** Room name for a document, given its file id (a store-relative path). */
export const docRoom = (id: string): string => `${DOC_PREFIX}${id}`;

/** Inverse of docRoom: the file id for a doc room, or null for other rooms. */
export function roomToFileId(room: string): string | null {
  return room.startsWith(DOC_PREFIX) ? room.slice(DOC_PREFIX.length) : null;
}

// Keys of the shared types within a document.
export const FILES_MAP = "files"; // index room: id -> FileMeta
export const ANNOTATIONS_ARRAY = "annotations"; // doc room: StoredAnnotation[]
// (Document content lives in y-prosemirror's XmlFragment, named by
// PM_FRAGMENT in src/editor/ydoc.ts — an editor concern, kept there.)

/** Metadata for one file, stored in the index room's FILES_MAP. */
export interface FileMeta {
  id: string;
  name: string;
  createdAt: number;
}

// --- File-id derivation (shared so client and server agree by construction) ---
// A file's identity IS its store-relative path (e.g. "notes/architecture.md").
// The client computes the id locally at create time and the server reuses the
// same functions, so there is exactly one notion of identity — no UUIDs, no
// reconciliation. Pure string logic (no fs), safe in the browser.

// Turn an arbitrary display name into a safe relative *.md id. Strips path
// separators and unsafe characters so a name can never escape the store or
// collide with the annotations sidecar suffix.
export function nameToFileId(name: string, dir = ""): string {
  const cleaned = name
    .replace(/[\\/]+/g, "-") // no nested dirs from a display name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]+/g, "") // control + fs-illegal chars
    .replace(/\s+/g, " ") // collapse whitespace runs
    .trim()
    .replace(/\.annotations$/i, "") // avoid clashing with sidecar naming
    .replace(/\.md$/i, "")
    .trim();
  const base = cleaned || "Untitled";
  return dir ? `${dir.replace(/\/+$/, "")}/${base}.md` : `${base}.md`;
}

// Pick an unused id near `id` by appending " 2", " 3", ... before .md.
// `exists` decides occupancy — the client passes a check against the in-memory
// index, the server one against the filesystem; same algorithm either way.
export function uniqueFileId(
  id: string,
  exists: (candidate: string) => boolean,
): string {
  if (!exists(id)) return id;
  const slash = id.lastIndexOf("/");
  const dir = slash >= 0 ? id.slice(0, slash + 1) : ""; // keeps trailing "/"
  const file = slash >= 0 ? id.slice(slash + 1) : id;
  const base = file.endsWith(".md") ? file.slice(0, -".md".length) : file;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${dir}${base} ${n}.md`;
    if (!exists(candidate)) return candidate;
  }
  return id;
}
