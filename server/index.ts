// Yjs collaboration server — the WebSocket relay.
//
// y-websocket v3 ships no server and @y/websocket-server pins an incompatible
// yjs v14, so we run our own: a small endpoint speaking the y-protocols sync +
// awareness wire format. One WebSocket URL path == one Yjs document ("room"):
// `redox:index` (the shared file list) and `redox:doc:<path>` (a file's content).
//
// This file is ONLY the relay (connections, awareness, broadcast) + bootstrap.
// Everything that makes files the source of truth — cold-load, flush, git,
// crash-WAL, the index sync, and teardown — lives in DocGateway (server/gateway.ts).
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { STORE_DIR } from "./paths";
import { DocGateway, DATA_DIR, WAL_ENABLED } from "./gateway";

const PORT = Number(process.env.PORT ?? 1234);
const PING_TIMEOUT = 30_000;

const messageSync = 0;
const messageAwareness = 1;

// Live, in-memory documents, keyed by room name. Loaded on first connection,
// unloaded by their gateway once the last client disconnects.
const docs = new Map<string, WSSharedDoc>();

// The WebSocket relay for one room: connection set, awareness, and broadcast of
// document + awareness updates. File persistence is delegated to `gateway`.
export class WSSharedDoc extends Y.Doc {
  name: string;
  // conn -> set of awareness client ids it controls (for cleanup on disconnect)
  conns = new Map<WebSocket, Set<number>>();
  awareness: awarenessProtocol.Awareness;
  // File-store lifecycle for this room (set by getDoc right after construction).
  gateway: DocGateway | null = null;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
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

    // Broadcast every document update to all connected clients (including the
    // gateway's cold-load seed, so a client that connected mid-load converges).
    this.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const buf = encoding.toUint8Array(encoder);
      this.conns.forEach((_ids, c) => send(this, c, buf));
    });
  }
}

// Get (or create) a room's document and attach + start its gateway. The gateway
// cold-loads from the git-backed store (files are the source of truth) and owns
// flushing/teardown.
function getDoc(name: string): WSSharedDoc {
  const existing = docs.get(name);
  if (existing) return existing;

  const doc = new WSSharedDoc(name);
  docs.set(name, doc);
  doc.gateway = new DocGateway(doc, () => {
    if (docs.get(name) === doc) docs.delete(name);
  });
  doc.gateway.start();
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
    // Last client gone: the gateway flushes any unsaved edits then unloads.
    if (doc.conns.size === 0) void doc.gateway?.onLastClientGone();
  }
  conn.close();
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
  const room =
    decodeURIComponent((req.url ?? "").slice(1).split("?")[0]) || "default";
  const doc = getDoc(room);
  doc.conns.set(conn, new Set());
  // A reconnect may have landed while a previous teardown was retrying a failed
  // final flush — cancel that pending teardown.
  doc.gateway?.onClientArrived();

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
