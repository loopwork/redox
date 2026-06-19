// Live, bidirectional file index (SERVER-ONLY).
//
// The unchanged client renders the sidebar from a Y.Map<id, FileMeta> living in
// the `redox:index` room. This module keeps that map in sync with the on-disk
// git-backed store, in BOTH directions:
//
//   filesystem -> Y.Map  (authoritative for the index)
//     A directory scan of *.md is published into the map. It is kept live with
//     fs.watch (recursive where supported) plus a periodic safety rescan, so a
//     file created / deleted / renamed on disk shows up while the room is open.
//
//   Y.Map -> filesystem  (reflect SAFE client mutations)
//     The client only ever mutates this map (create / rename / delete). We
//     mirror those to disk + git where it is unambiguous:
//       - delete of a server-published (path-keyed) entry -> git rm
//       - rename (display-name change) of a path-keyed entry -> git mv
//       - create (a client UUID-keyed entry) -> create an empty .md, then drop
//         the throwaway UUID entry; the rescan republishes the real path id.
//
// AUTHORITY NOTE: the filesystem is authoritative for the index. The client's
// UUID-keyed ids are a transient artifact of its create flow; the server turns
// them into path-keyed ids and reconciles. A client edit that cannot be mapped
// safely is ignored (and logged) rather than guessed at, so no disk data is
// destroyed by an ambiguous map mutation.
import fs from "node:fs";
import * as Y from "yjs";
import {
  scanFiles,
  createEmptyFile,
  renameStoreFile,
  deleteStoreFile,
} from "./store";
import { STORE_DIR, isFileId } from "./paths";
import type { CommitAuthor } from "./git";
import { FILES_MAP, type FileMeta } from "../src/shared/protocol";

const PUBLISH_DEBOUNCE_MS = 200; // coalesce bursts of fs events
const RESCAN_INTERVAL_MS = 5_000; // safety net if fs.watch misses an event

// Reconcile the on-disk *.md scan into the files Y.Map. Server-originated, so
// the client-mutation observer ignores it (no echo). Idempotent: only writes
// entries that actually changed and prunes ones whose file disappeared.
export function publishIndex(
  doc: Y.Doc,
  serverOrigin: unknown,
): void {
  const files = scanFiles();
  const map = doc.getMap<FileMeta>(FILES_MAP);
  doc.transact(() => {
    const seen = new Set<string>();
    for (const f of files) {
      seen.add(f.id);
      const prev = map.get(f.id);
      if (!prev || prev.name !== f.name || prev.createdAt !== f.createdAt) {
        map.set(f.id, { id: f.id, name: f.name, createdAt: f.createdAt });
      }
    }
    // Drop entries whose backing file disappeared — but only PATH-keyed ones we
    // published. Leave any not-yet-reconciled client UUID entries alone; the
    // observer handles those.
    for (const key of Array.from(map.keys())) {
      if (isFileId(key) && !seen.has(key)) map.delete(key);
    }
  }, serverOrigin);
}

// Read the editing user's display name from awareness, for git authorship.
// The client sets awareness field "user" = { name, color } (see FileEditor).
function authorFromAwareness(
  awareness: { getStates(): Map<number, Record<string, unknown>> } | undefined,
): CommitAuthor | undefined {
  if (!awareness) return undefined;
  for (const state of awareness.getStates().values()) {
    const user = state?.user as { name?: string } | undefined;
    if (user && typeof user.name === "string" && user.name.trim()) {
      return { name: user.name };
    }
  }
  return undefined;
}

export interface IndexSync {
  stop(): void;
}

// Wire up the live, bidirectional sync for the index room's doc. `serverOrigin`
// tags every server-side map write so the client-mutation observer can skip its
// own echoes. `getAwareness` lets git commits be attributed to the editing user.
export function startIndexSync(
  doc: Y.Doc,
  serverOrigin: unknown,
  getAwareness?: () =>
    | { getStates(): Map<number, Record<string, unknown>> }
    | undefined,
): IndexSync {
  const map = doc.getMap<FileMeta>(FILES_MAP);

  // ---- filesystem -> map -------------------------------------------------
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePublish = (): void => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = null;
      try {
        publishIndex(doc, serverOrigin);
      } catch (err) {
        console.error("index publish failed:", err);
      }
    }, PUBLISH_DEBOUNCE_MS);
  };

  // Initial publish.
  publishIndex(doc, serverOrigin);

  // Live watch. Node's recursive fs.watch is supported on macOS + Windows; on
  // Linux it may not be, so we also run a periodic rescan as a safety net (and
  // it covers the case where watch silently drops events).
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(
      STORE_DIR,
      { recursive: true },
      (_event, filename) => {
        // Only care about markdown content changes; ignore sidecars / .git.
        const name = filename ? filename.toString() : "";
        if (name.includes(".git")) return;
        if (name && !name.endsWith(".md")) return;
        schedulePublish();
      },
    );
    watcher.on("error", (err) => console.error("index watcher error:", err));
  } catch (err) {
    console.error("fs.watch unavailable, relying on periodic rescan:", err);
  }
  const rescan = setInterval(schedulePublish, RESCAN_INTERVAL_MS);

  // ---- map -> filesystem (reflect client mutations) ----------------------
  const onMap = (
    event: Y.YMapEvent<FileMeta>,
    txn: Y.Transaction,
  ): void => {
    // Ignore our own server-side writes (the publish above + reconciles below).
    if (txn.origin === serverOrigin) return;
    const author = authorFromAwareness(getAwareness?.());

    for (const [key, change] of event.keys) {
      try {
        reflectChange(doc, map, key, change, author, serverOrigin);
      } catch (err) {
        console.error(`index reflect failed for ${key}:`, err);
      }
    }
    // The reconciles above mutate disk; republish so the map converges to the
    // path-keyed truth.
    schedulePublish();
  };
  map.observe(onMap);

  return {
    stop(): void {
      if (publishTimer) clearTimeout(publishTimer);
      clearInterval(rescan);
      if (watcher) watcher.close();
      map.unobserve(onMap);
    },
  };
}

// Apply a single map-key change to the filesystem, where safe. `serverOrigin`
// is used for the cleanup write that removes a throwaway UUID create entry.
function reflectChange(
  doc: Y.Doc,
  map: Y.Map<FileMeta>,
  key: string,
  change: { action: "add" | "update" | "delete"; oldValue: FileMeta },
  author: CommitAuthor | undefined,
  serverOrigin: unknown,
): void {
  if (change.action === "delete") {
    // A path-keyed entry removed by the client -> remove the backing file.
    // (UUID-keyed deletes are our own cleanup or have no backing file.)
    if (isFileId(key)) deleteStoreFile(key, author);
    return;
  }

  const meta = map.get(key);
  if (!meta) return;

  if (change.action === "add") {
    if (isFileId(key)) {
      // The client added a path-keyed entry directly (unusual). Treat it as a
      // request to create that file if missing; scanFiles/publish will own it.
      createEmptyFile(meta.name || key, author);
      return;
    }
    // Client create flow: a UUID-keyed { id, name, createdAt } entry. Create an
    // empty .md from the name, then drop the throwaway UUID entry so the map
    // converges to the path-keyed id the rescan publishes.
    const newId = createEmptyFile(meta.name, author);
    if (newId) {
      doc.transact(() => {
        if (map.get(key)) map.delete(key);
      }, serverOrigin);
    }
    return;
  }

  // action === "update": a display-name change on a path-keyed entry -> rename.
  if (change.action === "update" && isFileId(key)) {
    const prevName = change.oldValue?.name;
    if (meta.name && meta.name !== prevName) {
      renameStoreFile(key, meta.name, author);
    }
  }
}
