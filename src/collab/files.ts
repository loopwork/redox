// The file list: a collaborative `Y.Map<id, FileMeta>` in the index room, plus a
// React binding so the sidebar re-renders when files are added/renamed/removed.
import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  INDEX_ROOM,
  FILES_MAP,
  nameToFileId,
  uniqueFileId,
  type FileMeta,
} from "./constants";
import { acquireRoom } from "./rooms";

// The index connection lives for the whole app session; never released.
let indexConn: ReturnType<typeof acquireRoom> | null = null;
function filesMap(): Y.Map<FileMeta> {
  if (!indexConn) indexConn = acquireRoom(INDEX_ROOM);
  return indexConn.doc.getMap<FileMeta>(FILES_MAP);
}

export function createFile(name: string): FileMeta {
  const display = name.trim() || "Untitled";
  const map = filesMap();
  // Identity IS the path: derive it (shared with the server, so they agree) and
  // dedupe against the files we already know about. No UUID, no reconciliation —
  // the room the editor opens is the canonical path room from the first keystroke.
  const id = uniqueFileId(nameToFileId(display), (candidate) => map.has(candidate));
  const meta: FileMeta = { id, name: display, createdAt: Date.now() };
  map.set(id, meta);
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

// --- React binding --------------------------------------------------------

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

// useSyncExternalStore-friendly: getSnapshot returns a cached, stable array that
// only changes identity when the file list actually changes.
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
