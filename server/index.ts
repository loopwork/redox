// Minimal Yjs collaboration server.
//
// y-websocket v3 no longer ships a server, and the official @y/websocket-server
// pins yjs v14 (incompatible with y-prosemirror's yjs v13). So we run our own:
// a small WebSocket endpoint speaking the y-protocols sync + awareness wire
// format, with every document persisted to LevelDB on disk.
//
// One WebSocket URL path == one Yjs document ("room"). The client uses three
// kinds of rooms: `redox:index` (the shared file list), `redox:doc:<id>` (a
// file's rich-text content) — see src/collab.ts.
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LeveldbPersistence } from "y-leveldb";
import {
  STORE_DIR,
  coldLoad,
  flush,
  roomToFileId,
  type CommitAuthor,
} from "./store";
import { startIndexSync, type IndexSync } from "./index-sync";

// Wire-level names mirrored from src/collab/constants.ts.
// That client module can't be imported here (it references `window` /
// `import.meta.env`), so the server keeps its own copy; both sides agree on the
// literal "redox:index" so the unchanged client reads what the server publishes.
const INDEX_ROOM = "redox:index";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = process.env.YDATA_DIR ?? "./data";
const PING_TIMEOUT = 30_000;
// Debounce window for flushing a live doc to disk after edits.
const FLUSH_DEBOUNCE_MS = 800;
// Back-off before retrying a flush that failed (e.g. transient disk error). The
// edit is still live in the Y.Doc; we keep retrying so it is not silently lost.
const FLUSH_RETRY_MS = 5_000;

// Files are canonical. LevelDB is kept ONLY as an optional crash-WAL, enabled
// by REDOX_WAL=1. When off (the default) nothing is written to ./data and the
// source of truth is purely the git-backed store.
const WAL_ENABLED = process.env.REDOX_WAL === "1";

const messageSync = 0;
const messageAwareness = 1;

// Origin tag for every Yjs transaction the SERVER initiates (cold-load seeding,
// index publishing). Lets our own update handlers ignore self-induced writes so
// a seed does not immediately trigger a redundant flush back to disk.
const SERVER_ORIGIN = Symbol("redox:server");
// Distinct origin for the optional WAL replay (REDOX_WAL=1). Kept separate from
// SERVER_ORIGIN so the WAL persist handler can skip re-storing the bytes it just
// replayed, while the file-flush handler still treats it as a non-user origin.
const WAL_REPLAY_ORIGIN = Symbol("redox:wal-replay");

// Update origins the file-flush handler must NOT treat as user edits (they come
// FROM disk/WAL, not from a client), so seeding never triggers a write-back.
function isServerOrigin(origin: unknown): boolean {
  return origin === SERVER_ORIGIN || origin === WAL_REPLAY_ORIGIN;
}

// Optional durable WAL for every room's document. Survives restarts; only used
// as a crash safety net behind REDOX_WAL since files are the source of truth.
const persistence: LeveldbPersistence | null = WAL_ENABLED
  ? new LeveldbPersistence(DATA_DIR)
  : null;

// Live, in-memory documents, keyed by room name. Loaded on first connection,
// unloaded once the last client for a room disconnects (data stays on disk).
const docs = new Map<string, WSSharedDoc>();

class WSSharedDoc extends Y.Doc {
  name: string;
  // conn -> set of awareness client ids it controls (for cleanup on disconnect)
  conns = new Map<WebSocket, Set<number>>();
  awareness: awarenessProtocol.Awareness;
  // File-store bookkeeping (only set for redox:doc:<path> rooms).
  fileId: string | null = null;
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  // True once the disk -> Y.Doc cold-load has completed, so the debounced flush
  // (offset->anchor translation) only runs against a fully-seeded doc.
  loaded = false;
  // Resolves when cold-load (the async getDoc block) finishes — success or not.
  // Lets the disconnect path await a fully-seeded doc before its final flush so
  // edits that raced the cold-load window are never lost (files are truth).
  loadComplete: Promise<void>;
  private resolveLoad!: () => void;
  // Set true by a client edit that arrives BEFORE cold-load completes. Once the
  // doc is loaded we flush, so those buffered edits reach disk even though the
  // edit handler couldn't schedule a flush at the time (the doc wasn't seeded
  // yet, and flushing then would have clobbered the file with an empty doc).
  dirtyDuringLoad = false;
  // Set true whenever a flush is attempted but fails (e.g. serialization throws,
  // disk full, permission denied). The data is still live in the Y.Doc; we keep
  // retrying on the next edit and force a final attempt on disconnect rather than
  // silently treating the failed write as success and losing the edit.
  flushFailed = false;
  // Pending retry of the FINAL flush after the last client left. While this is
  // set the doc is kept LIVE (not destroyed/unloaded) even with zero clients, so
  // a failing disk write is retried instead of dropping the user's last edits.
  finalFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Live filesystem<->Y.Map sync handle (only set for the redox:index room).
  indexSync: IndexSync | null = null;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.fileId = roomToFileId(name);
    this.loadComplete = new Promise<void>((resolve) => {
      this.resolveLoad = resolve;
    });
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        conn: WebSocket | null,
      ) => {
        const changed = added.concat(updated, removed);
        if (conn !== null) {
          const ids = this.conns.get(conn);
          if (ids) {
            added.forEach((id) => ids.add(id));
            removed.forEach((id) => ids.delete(id));
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        const buf = encoding.toUint8Array(encoder);
        this.conns.forEach((_ids, c) => send(this, c, buf));
      },
    );

    // Broadcast every document update to all connected clients.
    this.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const buf = encoding.toUint8Array(encoder);
      this.conns.forEach((_ids, c) => send(this, c, buf));

      // For file-backed doc rooms: debounce a flush to disk on real edits.
      // Skip server-induced updates (cold-load seeding / WAL replay) — those
      // came FROM disk, not from a client.
      if (this.fileId && !isServerOrigin(origin)) {
        if (this.loaded) {
          this.scheduleFlush();
        } else {
          // Edit arrived during the async cold-load window. We cannot flush yet
          // (the doc isn't seeded from disk; flushing now could clobber the
          // file). Remember that it's dirty so markLoaded() schedules a flush
          // once cold-load finishes — otherwise these edits would never reach
          // disk and a crash would lose them.
          this.dirtyDuringLoad = true;
        }
      }
    });
  }

  // Called once the async cold-load block finishes. Flushes any client edits
  // that raced the load window (buffered in the Y.Doc, never scheduled because
  // the doc wasn't loaded yet).
  markLoaded(): void {
    this.loaded = true;
    this.resolveLoad();
    if (this.fileId && this.dirtyDuringLoad) {
      this.dirtyDuringLoad = false;
      this.scheduleFlush();
    }
  }

  // Debounced write-back to the git-backed store.
  scheduleFlush(delay = FLUSH_DEBOUNCE_MS): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ok = this.flushNow();
      // If the write failed, the edit is still live in the Y.Doc — keep retrying
      // on a back-off so a transient disk error doesn't silently lose data. We do
      // NOT gate the retry on `conns.size > 0`: a client disconnecting mid-retry
      // must not abandon unflushed edits. (When the LAST client leaves,
      // finalizeAndUnload owns the retry-until-success loop instead; this guard
      // just avoids scheduling redundant timers once that has taken over or the
      // doc has been destroyed.)
      if (
        !ok &&
        this.loaded &&
        this.fileId &&
        !this.isDestroyed &&
        this.conns.size > 0
      ) {
        this.scheduleFlush(FLUSH_RETRY_MS);
      }
    }, delay);
  }

  // Immediate, synchronous flush (also used on last-client-disconnect).
  // Returns true if the doc was successfully written to disk. A failure (thrown
  // exception OR a flush() that reports it couldn't serialize/write) is NOT
  // treated as success: the live Y.Doc still holds the edit, so we record the
  // failure and keep retrying on the next edit / disconnect rather than dropping
  // user data. Only flush once the doc has been cold-loaded — flushing an
  // unseeded doc would write an empty file over the on-disk content.
  flushNow(): boolean {
    if (!this.fileId) return false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.loaded) {
      // Not seeded yet: defer. Mark dirty so markLoaded() retries.
      this.dirtyDuringLoad = true;
      return false;
    }
    try {
      const ok = flush(this, this.fileId, this.editingAuthor());
      // flush() returns false when it deliberately skipped (serialization could
      // not produce markdown). The data is unchanged on disk and still live in
      // the Y.Doc; remember so a later edit retries instead of silently dropping.
      this.flushFailed = !ok;
      return ok;
    } catch (err) {
      // A real write failure (disk full, EACCES, I/O error). The edit is still
      // in the Y.Doc; flag it so we retry and never report this as durable.
      console.error(`flush failed for ${this.name}:`, err);
      this.flushFailed = true;
      return false;
    }
  }

  // Attribute the git commit to the editing user, read from Yjs awareness (the
  // client broadcasts { user: { name, color } }). Falls back to the store's
  // default identity when no named user is present.
  editingAuthor(): CommitAuthor | undefined {
    for (const state of this.awareness.getStates().values()) {
      const user = (state as { user?: { name?: string } }).user;
      if (user && typeof user.name === "string" && user.name.trim()) {
        return { name: user.name };
      }
    }
    return undefined;
  }
}

// Get (or load) a room's document. Files (the git-backed store) are the source
// of truth: a doc room is cold-loaded from its .md + .annotations.json; the
// index room is populated by scanning the store for *.md files. LevelDB is only
// wired in as an optional crash-WAL (REDOX_WAL=1).
function getDoc(name: string): WSSharedDoc {
  const existing = docs.get(name);
  if (existing) return existing;

  const doc = new WSSharedDoc(name);
  docs.set(name, doc);

  // Cold-load + (optional) WAL binding. Connections that arrive during this
  // async window still converge: the applyUpdate/seed fires the 'update'
  // handler, which broadcasts the loaded state to them.
  void (async () => {
    try {
      // Optional crash-WAL. Register the persist handler BEFORE the async replay
      // so any client edit that arrives during the cold-load window is also
      // durably recorded in LevelDB — otherwise an edit between doc creation and
      // handler registration would be missing from the WAL. (Files remain the
      // canonical source; this only matters when REDOX_WAL=1 for crash recovery.)
      if (persistence) {
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          // Don't re-persist the state we just replayed FROM the WAL.
          if (origin === WAL_REPLAY_ORIGIN) return;
          void persistence!.storeUpdate(name, update);
        });
        const persisted = await persistence.getYDoc(name);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(persisted), WAL_REPLAY_ORIGIN);
      }

      if (doc.fileId) {
        // Document room: seed content + annotations from disk (no-op if absent).
        try {
          coldLoad(doc, doc.fileId, SERVER_ORIGIN);
        } catch (err) {
          console.error(`cold-load failed for ${name}:`, err);
        }
      } else if (name === INDEX_ROOM && docs.get(name) === doc) {
        // Index room: start the live, bidirectional filesystem <-> Y.Map sync so
        // the unchanged client renders (and can mutate) the on-disk file list.
        // Guard against a teardown that raced this async window (would leak a
        // watcher otherwise).
        doc.indexSync = startIndexSync(
          doc,
          SERVER_ORIGIN,
          () => doc.awareness,
        );
      }
    } finally {
      // Always mark loaded — success or failure — so the disconnect path's await
      // on loadComplete cannot hang, and buffered edits get a flush attempt.
      doc.markLoaded();
    }
  })();

  return doc;
}

function send(doc: WSSharedDoc, conn: WebSocket, message: Uint8Array): void {
  if (
    conn.readyState !== WebSocket.CONNECTING &&
    conn.readyState !== WebSocket.OPEN
  ) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(message, (err) => err && closeConn(doc, conn));
  } catch {
    closeConn(doc, conn);
  }
}

function closeConn(doc: WSSharedDoc, conn: WebSocket): void {
  const ids = doc.conns.get(conn);
  if (ids !== undefined) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(ids), null);
    if (doc.conns.size === 0) {
      // Last client gone: force a final flush so no edits are lost, then unload
      // from memory (files are the source of truth). This MUST run even if the
      // cold-load is still in flight — edits that arrived during that window are
      // buffered in the Y.Doc and would otherwise be lost. So we await load
      // completion before the final flush, then unload.
      void finalizeAndUnload(doc);
    }
  }
  conn.close();
}

// Final flush + unload after the last client leaves. Awaits cold-load so edits
// that raced the load window are seeded/flushed (never lost). If a new client
// reconnects while we wait, we abort the teardown and leave the doc live.
//
// CRITICAL: if the final flush FAILS (disk error, serialization error) we must
// NOT destroy the doc — that would discard the only copy of the user's last
// edits. Instead we keep the doc live in memory and retry the final flush on a
// back-off until it succeeds, only then tearing down. A reconnect during any
// retry window cancels the teardown (the new client's eventual disconnect will
// retrigger it).
async function finalizeAndUnload(doc: WSSharedDoc): Promise<void> {
  // Wait for cold-load so the doc is fully seeded and any buffered edits are
  // represented before we serialize to disk.
  await doc.loadComplete;
  attemptFinalFlush(doc);
}

// One attempt at the final flush after the last client left. On success the doc
// is destroyed and unloaded; on failure it stays live and we schedule another
// attempt so transient disk/serialization errors never lose the last edits.
function attemptFinalFlush(doc: WSSharedDoc): void {
  // A client may have (re)connected — keep the doc live; its own disconnect will
  // retrigger teardown. Cancel any pending final-flush retry.
  if (doc.conns.size > 0) {
    if (doc.finalFlushTimer) {
      clearTimeout(doc.finalFlushTimer);
      doc.finalFlushTimer = null;
    }
    return;
  }
  // The doc may already have been torn down + replaced by a reconnect cycle.
  if (docs.get(doc.name) !== doc) return;

  // Try to persist. If it fails, the live Y.Doc still holds the edits; keep the
  // doc alive and retry rather than destroying it (which would lose the data).
  if (doc.fileId && !doc.flushNow()) {
    console.error(
      `final flush failed for ${doc.name}; keeping doc live and retrying in ` +
        `${FLUSH_RETRY_MS}ms (no clients connected)`,
    );
    if (doc.finalFlushTimer) clearTimeout(doc.finalFlushTimer);
    doc.finalFlushTimer = setTimeout(() => {
      doc.finalFlushTimer = null;
      attemptFinalFlush(doc);
    }, FLUSH_RETRY_MS);
    return;
  }

  // Flush succeeded (or this is a non-file room): tear down.
  if (doc.finalFlushTimer) {
    clearTimeout(doc.finalFlushTimer);
    doc.finalFlushTimer = null;
  }
  // Tear down the live index watcher/observer if this is the index room.
  if (doc.indexSync) {
    doc.indexSync.stop();
    doc.indexSync = null;
  }
  doc.destroy();
  docs.delete(doc.name);
}

function onMessage(conn: WebSocket, doc: WSSharedDoc, data: Uint8Array): void {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case messageSync: {
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        // Only reply if readSyncMessage wrote a response (length > type byte).
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        );
        break;
      }
    }
  } catch (err) {
    console.error("message error", err);
  }
}

function setupConnection(conn: WebSocket, req: http.IncomingMessage): void {
  conn.binaryType = "arraybuffer";
  const room = decodeURIComponent((req.url ?? "").slice(1).split("?")[0]) || "default";
  const doc = getDoc(room);
  doc.conns.set(conn, new Set());
  // A reconnect may have landed while a previous teardown was retrying a failed
  // final flush. Cancel that pending teardown so the now-live doc is not
  // destroyed out from under the new client.
  if (doc.finalFlushTimer) {
    clearTimeout(doc.finalFlushTimer);
    doc.finalFlushTimer = null;
  }

  conn.on("message", (message: ArrayBuffer) =>
    onMessage(conn, doc, new Uint8Array(message)),
  );

  // Liveness check: drop connections that stop answering pings.
  let alive = true;
  const interval = setInterval(() => {
    if (!alive) {
      if (doc.conns.has(conn)) closeConn(doc, conn);
      clearInterval(interval);
      return;
    }
    if (doc.conns.has(conn)) {
      alive = false;
      try {
        conn.ping();
      } catch {
        closeConn(doc, conn);
      }
    }
  }, PING_TIMEOUT);
  conn.on("pong", () => (alive = true));
  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(interval);
  });

  // Kick off the sync handshake: send our state vector, then current awareness.
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, messageSync);
  syncProtocol.writeSyncStep1(syncEncoder, doc);
  send(doc, conn, encoding.toUint8Array(syncEncoder));

  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(states.keys()),
      ),
    );
    send(doc, conn, encoding.toUint8Array(awarenessEncoder));
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("redox collab server\n");
});

const wss = new WebSocketServer({ server });
wss.on("connection", setupConnection);

server.listen(PORT, () => {
  console.log(
    `redox collab server on ws://localhost:${PORT} ` +
      `(store: ${STORE_DIR}${WAL_ENABLED ? `, WAL: ${DATA_DIR}` : ", WAL off"})`,
  );
});
