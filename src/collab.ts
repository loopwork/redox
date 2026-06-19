// Client-side collaboration layer.
//
// Every "room" is one Yjs document synced over a WebSocket to the server
// (server/index.ts). We use two kinds of rooms:
//
//   redox:index       a shared Y.Map<id, FileMeta> — the collaborative file list
//   redox:doc:<id>    one file's rich-text content (+ its annotations)
//
// Connections are cached and reference-counted so switching files (or a React
// StrictMode double-mount) reuses a live socket instead of reconnecting.
import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `ws://${window.location.hostname}:1234`;

const INDEX_ROOM = "redox:index";

export interface FileMeta {
  id: string;
  name: string;
  createdAt: number;
}

export interface RoomConnection {
  doc: Y.Doc;
  provider: WebsocketProvider;
  refs: number;
  destroyTimer?: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, RoomConnection>();

export function docRoom(id: string): string {
  return `redox:doc:${id}`;
}

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

// --- File index (collaborative file list) ---------------------------------

// The index connection lives for the whole app session; never released.
let indexConn: RoomConnection | null = null;
function filesMap(): Y.Map<FileMeta> {
  if (!indexConn) indexConn = acquireRoom(INDEX_ROOM);
  return indexConn.doc.getMap<FileMeta>("files");
}

export function createFile(name: string): FileMeta {
  const meta: FileMeta = {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled",
    createdAt: Date.now(),
  };
  filesMap().set(meta.id, meta);
  return meta;
}

export function renameFile(id: string, name: string): void {
  const map = filesMap();
  const meta = map.get(id);
  if (!meta) return;
  map.set(id, { ...meta, name: name.trim() || meta.name });
}

export function deleteFile(id: string): void {
  filesMap().delete(id);
}

// --- React binding for the file list --------------------------------------

let snapshot: FileMeta[] = [];
const listeners = new Set<() => void>();
let started = false;

function recompute(): void {
  snapshot = Array.from(filesMap().values()).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const map = filesMap();
  const onChange = () => {
    recompute();
    listeners.forEach((l) => l());
  };
  map.observe(onChange);
  recompute();
}

// useSyncExternalStore-friendly: getSnapshot returns a cached, stable array
// that only changes identity when the file list actually changes.
export function useFiles(): FileMeta[] {
  return useSyncExternalStore(
    (cb) => {
      ensureStarted();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

// --- Local user identity (for awareness cursors) --------------------------

const USER_KEY = "redox-user";
const USER_COLORS = [
  "#f97316",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#eab308",
];

export interface LocalUser {
  name: string;
  color: string;
}

export function getLocalUser(): LocalUser {
  const raw = window.localStorage.getItem(USER_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LocalUser;
    } catch {
      /* fall through and regenerate */
    }
  }
  const n = Math.floor(Math.random() * 1000);
  const user: LocalUser = {
    name: `User ${n}`,
    color: USER_COLORS[n % USER_COLORS.length],
  };
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}
