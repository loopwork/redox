// Per-document file-store lifecycle (SERVER-ONLY).
//
// WSSharedDoc (server/index.ts) is the Yjs WebSocket *relay*: connections,
// awareness, broadcast. This class owns everything that makes files the source
// of truth for one room — cold-load from disk, debounced write-back + git
// commit, the optional crash-WAL, and the live filesystem<->Y.Map index sync —
// plus the final-flush-then-unload teardown after the last client leaves.
//
// The data-loss-critical invariants live here:
//   - never flush before cold-load (would write an empty doc over the file)
//   - edits that race the cold-load window are buffered (dirtyDuringLoad) and
//     flushed once loaded
//   - a failed flush keeps the doc live and retries; on last-disconnect the doc
//     is NOT destroyed until its final flush succeeds
//   - the disk cold-load is DEFERRED until a connecting client's initial sync
//     settles, then seeds only if the doc is still empty (ensureLoaded). This is
//     what stops content from DUPLICATING when the server restarts and a client
//     reconnects: seeding mints fresh CRDT ids, so merging a seed on top of the
//     client's retained state would double the document. Letting the client's
//     state arrive first means the empty-guard skips the seed (and we instead
//     flush the client's state, recovering any edits made since the last flush).
import * as Y from "yjs";
import { LeveldbPersistence } from "y-leveldb";
import { INDEX_ROOM, roomToFileId } from "../src/shared/protocol";
import { isFileId } from "./paths";
import { coldLoad, flush } from "./store";
import type { CommitAuthor } from "./git";
import { startIndexSync, type IndexSync } from "./index-sync";
import type { WSSharedDoc } from "./index";

export const DATA_DIR = process.env.YDATA_DIR ?? "./data";
// Files are canonical. LevelDB is an optional crash-WAL, enabled by REDOX_WAL=1.
export const WAL_ENABLED = process.env.REDOX_WAL === "1";

// Debounce window for flushing a live doc to disk after edits.
const FLUSH_DEBOUNCE_MS = 800;
// Back-off before retrying a flush that failed (transient disk error). The edit
// is still live in the Y.Doc; we keep retrying so it is not silently lost.
const FLUSH_RETRY_MS = 5_000;

// Origin tags for Yjs transactions the SERVER initiates, so the update handler
// can tell them apart from real client edits.
//   SERVER_ORIGIN     — cold-load seeding / index publishing (came FROM disk)
//   WAL_REPLAY_ORIGIN — replay of the optional LevelDB WAL on load
const SERVER_ORIGIN = Symbol("redox:server");
const WAL_REPLAY_ORIGIN = Symbol("redox:wal-replay");
function isServerOrigin(origin: unknown): boolean {
  return origin === SERVER_ORIGIN || origin === WAL_REPLAY_ORIGIN;
}

// Optional durable WAL shared across all rooms (only when REDOX_WAL=1).
const persistence: LeveldbPersistence | null = WAL_ENABLED
  ? new LeveldbPersistence(DATA_DIR)
  : null;

export class DocGateway {
  private readonly doc: WSSharedDoc;
  // Store-relative file id for redox:doc:<path> rooms; null for other rooms.
  private readonly fileId: string | null;
  // Removes this doc from the live registry once unloaded.
  private readonly onUnload: () => void;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private finalFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // True once the disk -> Y.Doc cold-load has completed, so a flush only ever
  // runs against a fully-seeded doc.
  private loaded = false;
  // An edit arrived before cold-load finished: flush once loaded so it reaches
  // disk (flushing mid-load could clobber the file with an empty doc).
  private dirtyDuringLoad = false;
  // Set once the doc has been torn down, to guard against a double teardown.
  private unloaded = false;
  // Live filesystem<->Y.Map index sync (only for the redox:index room).
  private indexSync: IndexSync | null = null;
  // Disk cold-load is deferred until a client's initial sync settles
  // (ensureLoaded); this guards it to run exactly once.
  private coldLoadDone = false;
  // Resolves once the optional WAL replay has been applied, so the deferred
  // cold-load never races ahead of the server's own persisted state.
  private walReady: Promise<void> = Promise.resolve();

  // Resolves when cold-load finishes (success or not) so the disconnect path can
  // await a fully-seeded doc before its final flush — edits that raced the load
  // window are then never lost.
  readonly loadComplete: Promise<void>;
  private resolveLoad!: () => void;

  constructor(doc: WSSharedDoc, onUnload: () => void) {
    this.doc = doc;
    // A room is file-backed iff its id is a path (".md"). Invariant guardrail:
    // a malformed/non-path room can never write a bare orphan file.
    const id = roomToFileId(doc.name);
    this.fileId = id && isFileId(id) ? id : null;
    this.onUnload = onUnload;
    this.loadComplete = new Promise<void>((resolve) => {
      this.resolveLoad = resolve;
    });
  }

  // Register the WAL/flush update handler and kick off cold-load. Registering the
  // handler synchronously (before the async load) ensures an edit arriving during
  // the load window is still WAL-persisted and marked dirty for a later flush.
  start(): void {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Optional WAL: persist everything except the bytes we just replayed.
      if (persistence && origin !== WAL_REPLAY_ORIGIN) {
        void persistence.storeUpdate(this.doc.name, update);
      }
      // Debounced flush for file-backed rooms, on real client edits only.
      if (this.fileId && !isServerOrigin(origin)) {
        if (this.loaded) this.scheduleFlush();
        else this.dirtyDuringLoad = true;
      }
    });

    // Optional WAL replay (the server's own persisted state). Everything that
    // seeds the doc waits on this so it is never overtaken by the disk cold-load.
    this.walReady = (async () => {
      if (!persistence) return;
      try {
        const persisted = await persistence.getYDoc(this.doc.name);
        Y.applyUpdate(
          this.doc,
          Y.encodeStateAsUpdate(persisted),
          WAL_REPLAY_ORIGIN,
        );
      } catch (err) {
        console.error(`WAL replay failed for ${this.doc.name}:`, err);
      }
    })();

    if (this.fileId) {
      // Document room: DEFER the disk cold-load to ensureLoaded(), triggered once
      // a connecting client's initial sync has settled (see the invariant note at
      // the top of this file). markLoaded() therefore happens in ensureLoaded.
      return;
    }

    void this.walReady.then(() => {
      if (this.unloaded) return;
      // Index room: live, bidirectional filesystem <-> Y.Map sync. (No
      // client-content race — its state is the filesystem, not a cold-load.)
      if (this.doc.name === INDEX_ROOM) {
        this.indexSync = startIndexSync(
          this.doc,
          SERVER_ORIGIN,
          () => this.doc.awareness,
        );
      }
      this.markLoaded();
    });
  }

  // Seed a document room from disk — but only once, and only after a connecting
  // client's initial sync has been applied, so a reconnecting client's own state
  // wins (coldLoad's empty-guard then skips, avoiding the restart-duplication
  // merge). Called by the relay after the first syncStep2/update on the room, and
  // by onLastClientGone as a fallback for a client that never synced.
  async ensureLoaded(): Promise<void> {
    if (this.coldLoadDone || !this.fileId) return;
    this.coldLoadDone = true;
    await this.walReady; // WAL (if any) is authoritative; apply it first.
    try {
      coldLoad(this.doc, this.fileId, SERVER_ORIGIN);
    } catch (err) {
      console.error(`cold-load failed for ${this.doc.name}:`, err);
    }
    this.markLoaded();
  }

  // A client (re)connected — cancel any pending teardown so the now-live doc is
  // not destroyed out from under it.
  onClientArrived(): void {
    if (this.finalFlushTimer) {
      clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = null;
    }
  }

  // The last client left: flush (awaiting cold-load first) then unload. If a new
  // client reconnects while we wait, attemptFinalFlush aborts the teardown.
  async onLastClientGone(): Promise<void> {
    // Kick a deferred cold-load that a never-synced client left pending, so the
    // doc is seeded (loadComplete resolves) before the final flush — otherwise we
    // could flush an empty doc over the file, or hang awaiting loadComplete.
    void this.ensureLoaded();
    await this.loadComplete;
    this.attemptFinalFlush();
  }

  private markLoaded(): void {
    this.loaded = true;
    this.resolveLoad();
    if (this.fileId && this.dirtyDuringLoad) {
      this.dirtyDuringLoad = false;
      this.scheduleFlush();
    }
  }

  private scheduleFlush(delay = FLUSH_DEBOUNCE_MS): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ok = this.flushNow();
      // Retry transient failures while clients remain. (After the last client
      // leaves, attemptFinalFlush owns the retry-until-success loop instead.)
      if (
        !ok &&
        this.loaded &&
        this.fileId &&
        !this.doc.isDestroyed &&
        this.doc.conns.size > 0
      ) {
        this.scheduleFlush(FLUSH_RETRY_MS);
      }
    }, delay);
  }

  // Immediate synchronous flush. Returns true only if written to disk. A failure
  // (throw, or a flush() that couldn't serialize) is never treated as success:
  // the live Y.Doc still holds the edit, so we record it and retry rather than
  // dropping data. Never flush an unseeded doc (would write an empty file).
  private flushNow(): boolean {
    if (!this.fileId) return false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.loaded) {
      this.dirtyDuringLoad = true;
      return false;
    }
    try {
      return flush(this.doc, this.fileId, this.editingAuthor());
    } catch (err) {
      console.error(`flush failed for ${this.doc.name}:`, err);
      return false;
    }
  }

  // Attribute the git commit to the editing user (from Yjs awareness, which the
  // client broadcasts as { user: { name, color } }); fall back to the store default.
  private editingAuthor(): CommitAuthor | undefined {
    for (const state of this.doc.awareness.getStates().values()) {
      const user = (state as { user?: { name?: string } }).user;
      if (user && typeof user.name === "string" && user.name.trim()) {
        return { name: user.name };
      }
    }
    return undefined;
  }

  // One attempt at the final flush after the last client left. On success the
  // doc is destroyed + unloaded; on failure it stays live and retries so a
  // transient disk/serialization error never loses the last edits.
  private attemptFinalFlush(): void {
    // A client reconnected — keep the doc live; its disconnect retriggers this.
    if (this.doc.conns.size > 0) {
      if (this.finalFlushTimer) {
        clearTimeout(this.finalFlushTimer);
        this.finalFlushTimer = null;
      }
      return;
    }
    if (this.unloaded) return;

    if (this.fileId && !this.flushNow()) {
      console.error(
        `final flush failed for ${this.doc.name}; keeping doc live and ` +
          `retrying in ${FLUSH_RETRY_MS}ms (no clients connected)`,
      );
      if (this.finalFlushTimer) clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = setTimeout(() => {
        this.finalFlushTimer = null;
        this.attemptFinalFlush();
      }, FLUSH_RETRY_MS);
      return;
    }

    // Flushed (or a non-file room): tear down.
    if (this.finalFlushTimer) {
      clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = null;
    }
    if (this.indexSync) {
      this.indexSync.stop();
      this.indexSync = null;
    }
    this.unloaded = true;
    this.doc.destroy();
    this.onUnload();
  }
}
