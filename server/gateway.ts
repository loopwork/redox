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

    void (async () => {
      try {
        if (persistence) {
          const persisted = await persistence.getYDoc(this.doc.name);
          Y.applyUpdate(
            this.doc,
            Y.encodeStateAsUpdate(persisted),
            WAL_REPLAY_ORIGIN,
          );
        }
        if (this.fileId) {
          // Document room: seed content + annotations from disk (no-op if absent).
          try {
            coldLoad(this.doc, this.fileId, SERVER_ORIGIN);
          } catch (err) {
            console.error(`cold-load failed for ${this.doc.name}:`, err);
          }
        } else if (this.doc.name === INDEX_ROOM && !this.unloaded) {
          // Index room: live, bidirectional filesystem <-> Y.Map sync. Guard
          // against a teardown that raced this async window (would leak a watcher).
          this.indexSync = startIndexSync(
            this.doc,
            SERVER_ORIGIN,
            () => this.doc.awareness,
          );
        }
      } finally {
        // Always mark loaded so the disconnect path's await cannot hang and any
        // buffered edits get a flush attempt.
        this.markLoaded();
      }
    })();
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
