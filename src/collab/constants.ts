// Shared constants for the collaboration layer: where to connect, how rooms are
// named, and the keys of the Yjs shared types inside each document. Centralized
// so the client, server, and any tooling agree on the same wire-level names.

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `ws://${window.location.hostname}:1234`;

// Room names (one room == one Yjs document on the server).
export const INDEX_ROOM = "redox:index";
export const docRoom = (id: string): string => `redox:doc:${id}`;

// Keys of the shared types within a document.
export const FILES_MAP = "files"; // in the index room: id -> FileMeta
export const ANNOTATIONS_ARRAY = "annotations"; // in a doc room: StoredAnnotation[]
// Document content lives in y-prosemirror's default XmlFragment named
// "prosemirror"; it is managed by the editor, not accessed directly here.

// Origin tag for Yjs transactions this app initiates, so observers can ignore
// their own echoes and avoid apply -> write -> apply feedback loops.
export const LOCAL_ORIGIN = { source: "redox" };
