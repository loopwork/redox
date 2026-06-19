// Connection pool. Every room is one Yjs document synced over a WebSocket to the
// server. Connections are cached and reference-counted so switching files (or a
// React StrictMode double-mount) reuses a live socket instead of reconnecting.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WS_URL } from "./constants";

export interface RoomConnection {
  doc: Y.Doc;
  provider: WebsocketProvider;
  refs: number;
  destroyTimer?: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, RoomConnection>();

function createConnection(room: string): RoomConnection {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, room, doc, { connect: true });
  const conn: RoomConnection = { doc, provider, refs: 0 };
  rooms.set(room, conn);
  return conn;
}

function teardown(room: string, conn: RoomConnection): void {
  if (conn.destroyTimer) {
    clearTimeout(conn.destroyTimer);
    conn.destroyTimer = undefined;
  }
  conn.provider.destroy();
  conn.doc.destroy();
  if (rooms.get(room) === conn) rooms.delete(room);
}

// Called from render to get the connection the editor will bind to.
//
// If the cached connection is pending teardown, that means it was released and
// this is a *genuine* remount (e.g. switching back to a file). Rebinding
// y-prosemirror to the already-populated, reused Y.Doc renders an empty editor
// (it only does the initial fragment->editor sync once per doc), so we tear it
// down and hand back a fresh connection that re-syncs from the server.
//
// A React StrictMode remount does NOT re-run render — it only re-runs effects,
// i.e. acquireRoom — so it reuses the live connection instead and is unaffected.
export function getRoom(room: string): RoomConnection {
  const conn = rooms.get(room);
  if (conn && !conn.destroyTimer) return conn;
  if (conn) teardown(room, conn); // pending teardown: start clean
  return createConnection(room);
}

export function acquireRoom(room: string): RoomConnection {
  let conn = rooms.get(room);
  if (!conn) conn = createConnection(room);
  // Reuse the live connection (cancel any pending teardown). Crucially this does
  // NOT recreate it, so a StrictMode re-acquire keeps the editor's provider.
  if (conn.destroyTimer) {
    clearTimeout(conn.destroyTimer);
    conn.destroyTimer = undefined;
  }
  conn.refs += 1;
  return conn;
}

export function releaseRoom(room: string): void {
  const conn = rooms.get(room);
  if (!conn) return;
  conn.refs -= 1;
  if (conn.refs > 0) return;
  // Defer teardown so a StrictMode remount re-acquires before it fires. A real
  // switch-back instead recreates via getRoom (see above).
  conn.destroyTimer = setTimeout(() => {
    if (conn.refs <= 0) teardown(room, conn);
  }, 2000);
}
