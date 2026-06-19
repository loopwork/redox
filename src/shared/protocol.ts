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
