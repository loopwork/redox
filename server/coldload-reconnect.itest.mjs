// Integration regression test for the cold-load reconnect-duplication bug.
//
// Run: `node server/coldload-reconnect.itest.mjs` (or `npm run test:integration`).
// Not part of the fast unit suite (`npm test`) because it spawns a real server
// process and drives it over a real WebSocket — it takes ~12s.
//
// The bug: when a room is re-created (server restart, or unload-then-reconnect)
// the server re-cold-loads the markdown into a FRESH Y.Doc — new CRDT ids each
// parse. A client that reconnects carrying its prior state merges the two id
// sets, DUPLICATING the document. The fix defers the disk cold-load until a
// connecting client's initial sync settles and seeds only if still empty, so a
// reconnecting client's state wins (see server/gateway.ts ensureLoaded).
//
// This test drives the deterministic version of the scenario: connect a client,
// disconnect it (the room flushes + unloads) while keeping its Y.Doc, then
// reconnect (the room re-creates and would re-seed). The document must still
// contain exactly ONE copy of its content.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.ITEST_PORT ?? "1236";
const MARKER = "UNIQUEMARKER";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = fs.mkdtempSync(path.join(os.tmpdir(), "redox-itest-"));
fs.writeFileSync(path.join(store, "note.md"), `# Note\n\n${MARKER} body.\n`);
const git = (...a) => spawnSync("git", ["-C", store, ...a], { stdio: "ignore" });
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

const server = spawn("npx", ["tsx", "server/index.ts"], {
  env: { ...process.env, PORT, REDOX_STORE_DIR: store, REDOX_WAL: "" },
  stdio: "ignore",
});

const cleanup = () => {
  server.kill("SIGKILL");
  fs.rmSync(store, { recursive: true, force: true });
};

let failed = false;
try {
  await sleep(3000); // server boot

  const doc = new Y.Doc();
  const provider = new WebsocketProvider(
    `ws://localhost:${PORT}`,
    "redox:doc:note.md",
    doc,
    { connect: true, WebSocketPolyfill: WS },
  );
  const frag = doc.getXmlFragment("prosemirror");
  const count = () => (frag.toString().match(new RegExp(MARKER, "g")) ?? []).length;

  await sleep(3000);
  const c1 = count();
  console.log(`after first connect: ${c1} copy(ies)`);

  provider.disconnect(); // room flushes + unloads, but `doc` keeps its state
  await sleep(3500);
  provider.connect(); // room re-creates and would re-seed
  await sleep(4000);

  const c2 = count();
  console.log(`after reconnect:     ${c2} copy(ies)`);

  provider.destroy();

  if (c1 !== 1 || c2 !== 1) {
    console.error(`FAIL: expected 1 copy throughout, got ${c1} then ${c2}`);
    failed = true;
  } else {
    console.log("PASS: no duplication across reconnect");
  }
} catch (err) {
  console.error("FAIL: error", err);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
