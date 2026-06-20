// Client-side collaboration constants. The wire-level names (room names, Yjs
// keys, FileMeta) are shared with the server and live in src/shared/protocol.ts;
// they are re-exported here so existing client imports from "./collab" are
// unchanged. This file additionally holds the strictly client-side bits that
// reference browser globals and therefore cannot live in the shared module.
export {
  INDEX_ROOM,
  DOC_PREFIX,
  docRoom,
  roomToFileId,
  nameToFileId,
  uniqueFileId,
  FILES_MAP,
  ANNOTATIONS_ARRAY,
  type FileMeta,
} from "../shared/protocol";

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `ws://${window.location.hostname}:1234`;

// Origin tag for Yjs transactions this app initiates (annotation write-back), so
// observers can ignore their own echoes and avoid apply -> write -> apply loops.
export const LOCAL_ORIGIN = { source: "redox" };
