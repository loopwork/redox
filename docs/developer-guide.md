# redox — Developer Guide

This is the architecture reference for working on redox. It explains the design
and, more importantly, *why* it is the way it is. The companion
[User Guide](./user-guide.md) covers using the app; this document is for people
changing the code.

Every claim here is meant to match the source. When in doubt, the cited file
wins — and please fix this guide if it drifts.

---

## 1. What redox is

A multi-file, collaborative rich-text editor. People open the same document by
URL and edit it together in real time, with live cursors and side-note
annotations. Documents are plain markdown files in a git repository; the live
collaborative session is layered on top.

The whole design follows from one decision:

> **Files are the source of truth.** A document *is* a markdown file on disk.
> Everything else — the CRDT, the WebSocket session, LevelDB — is derived, and
> can be thrown away and rebuilt from the files.

Keep that sentence in mind; most of the architecture is a consequence of it.

---

## 2. The big picture

```
  browser (React + Remirror/ProseMirror)
     │  Yjs document, synced over one WebSocket per room
     ▼
  WebSocket relay            server/index.ts
     │  connections, awareness, broadcast — nothing else
     ▼
  per-document gateway       server/gateway.ts
     │  cold-load · debounced flush · teardown · (optional WAL)
     ▼
  markdown store             server/store.ts  →  <store>/<path>.md
                                                  <store>/<path>.annotations.json
```

Two processes run in development:

- **Vite** serves the web app (`http://localhost:5173`).
- The **collab server** is a small Node WebSocket server (`ws://localhost:1234`).

They are independent; `npm run dev` just runs both together.

### Module map

Server (`server/`, Node-only):

| File | Responsibility |
| --- | --- |
| `index.ts` | The WebSocket **relay**: accept connections, speak the Yjs sync + awareness wire format, broadcast. One URL path = one room. Owns no persistence. |
| `gateway.ts` | `DocGateway`: the per-room **lifecycle** — cold-load, debounced flush, teardown, the optional crash-WAL. This is the data-loss-critical file. |
| `store.ts` | Turn a live `Y.Doc` into files and back (cold-load / flush), scan the store for the index, and reflect index CRUD to disk. Holds the corruption size guards. |
| `paths.ts` | Pure path / file-id math (no fs, no git). `STORE_DIR`, `mdPathFor`, path-traversal guard. |
| `git.ts` | Git plumbing for the store repo (every write is committed). |
| `anchoring.ts` | Translate annotations between live offsets and on-disk text anchors. |
| `index-sync.ts` | Keep the file index (`redox:index` `Y.Map`) in sync with the on-disk `*.md` set, both directions. |

Client (`src/`):

| Area | Responsibility |
| --- | --- |
| `shared/protocol.ts` | Wire contract shared by client **and** server: room names, shared-type keys, `FileMeta`, and the `id`-from-name derivation. DOM-free so the server can import it. |
| `collab/` | `constants.ts` (WS URL, origin tag), `rooms.ts` (ref-counted connection pool), `files.ts` (the file index + `useFiles`), `user.ts` (local identity for cursors). |
| `editor/` | The markdown ↔ ProseMirror bridge (`markdown*.ts`, `ydoc.ts`), the schema (`schema.ts`, `contentExtensions.ts`), and the per-file Remirror extension stack (`extensions.ts`). |
| `annotations/` | `types.ts` and `useAnnotationSync.ts` — the two-way editor ↔ Yjs sync for annotations. |
| `components/` | `Sidebar`, `TopBar`, `FileEditor`, `AnnotationToolbar`, `SideNotes`, `EmptyState`. |
| `hooks/useActiveFile.ts` | Active file selection, backed by the URL hash. |
| `App.tsx` | The shell: sidebar + the active file's editor. |

---

## 3. Identity is the path

A document's **id is its store-relative path, including `.md`** — e.g.
`docs/proposals/t3.md`. There is no separate UUID, no id-to-path mapping table.

- The room for a document is `redox:doc:<id>` (`docRoom` in
  [protocol.ts](../src/shared/protocol.ts)).
- The on-disk file is `<store>/<id>` and its annotations sidecar is
  `<store>/<id-without-.md>.annotations.json` ([paths.ts](../server/paths.ts)).

Why one id and not two: the client and server both derive the id from the
display name with the *same* function (`nameToFileId`), so they agree by
construction. `nameToFileId` strips path separators and filesystem-illegal
characters, so a name can never escape the store or collide with the
`.annotations.json` suffix. `uniqueFileId` appends ` 2`, ` 3`, … to avoid
collisions — the client checks against the in-memory index, the server against
the filesystem, but it's the same algorithm. Naming a file is therefore a pure
string operation shared by both sides; there is nothing to reconcile.

`assertInsideStore` ([paths.ts](../server/paths.ts)) is the backstop: every
filesystem path is re-checked to be under `STORE_DIR` before it's touched, so
even a malformed id cannot write outside the store.

---

## 4. Three representations and the bridge

The same document content exists in three shapes:

1. **Markdown** — on disk, the source of truth.
2. **ProseMirror JSON** — the editor's document model (the schema).
3. **Yjs `XmlFragment`** — the live CRDT, what y-prosemirror syncs between peers.

The bridge between them lives in `src/editor/` and is **pure string/JSON logic,
no DOM** — that's the constraint that lets the Node server run it headlessly.

- `markdown.ts` is the public API (four functions: markdown ⇄ ProseMirror JSON,
  markdown ⇄ ProseMirror node). It composes three single-concern modules:
  - `markdown-tokenizer.ts` — the markdown-it instance (CommonMark + GFM
    strikethrough + tables) plus two core rules: one maps `<u>…</u>` inline HTML
    to an underline mark, one wraps table-cell content in paragraphs (cells hold
    block content).
  - `markdown-parser.ts` — markdown-it tokens → ProseMirror nodes, named for
    *our* schema (`bulletList`, `bold`, … not the prosemirror-markdown defaults).
  - `markdown-serializer.ts` — ProseMirror → markdown, including the GFM table
    writer.
- `ydoc.ts` bridges ProseMirror JSON ⇄ Yjs using y-prosemirror, under the
  fragment key `PM_FRAGMENT = "prosemirror"` — the same key the browser editor's
  `YjsExtension` uses, so a doc seeded on the server is byte-compatible with the
  client.
- `schema.ts` builds the ProseMirror schema headlessly from
  `contentExtensions.ts`, the **single source of truth for which nodes/marks
  exist**. The browser editor and the server schema derive from the same list,
  so they can never disagree about the document shape.

Why not reuse prosemirror-markdown's defaults or Remirror's own markdown
helpers: the defaults target a different schema (different node names), and
Remirror's helpers go markdown → HTML → ProseMirror via the DOM, which doesn't
exist in Node. prosemirror-markdown + markdown-it are pure string code, so the
same bridge runs in the browser and on the server.

---

## 5. The document lifecycle (and its data-loss invariants)

This is the most delicate code in the project. It lives in
[gateway.ts](../server/gateway.ts) (`DocGateway`), one instance per room.

### Cold-load (disk → Y.Doc)

When a document room is created, its content and annotations are seeded from
disk — but **the seed is deferred until a connecting client's initial sync has
settled, and runs only if the doc is still empty** (`ensureLoaded`). The relay
calls `ensureLoaded` after the first content-bearing sync message; the gateway
also kicks it from `onLastClientGone` as a fallback.

Why deferred, not eager: seeding builds a *fresh* Y.Doc, so the same markdown
gets new CRDT ids every parse. If the server re-seeded a room while a client was
reconnecting with its prior state, Yjs would merge the two id sets and
**duplicate the entire document** — and it compounds, doubling on every
reconnect. Letting the client's state arrive first means the empty-guard skips
the seed; the client's state wins (and any edits it made while disconnected get
flushed). A genuinely new doc still seeds, because an empty client leaves the
doc empty. This is verified by `server/coldload-reconnect.itest.mjs`
(`npm run test:integration`).

### Flush (Y.Doc → disk)

Edits schedule a **debounced** flush (`FLUSH_DEBOUNCE_MS = 800`). `flush`
([store.ts](../server/store.ts)) serializes the doc to its `.md`, writes the
annotations sidecar (or removes it when the last annotation is gone), and
commits via git. The commit is attributed to the editing user, read from Yjs
awareness.

### Teardown

When the last client leaves, the gateway flushes, then unloads (destroys the
`Y.Doc`, drops it from the registry). If a client reconnects mid-teardown,
`onClientArrived` cancels it.

### The invariants (don't break these)

- **Never flush before cold-load** — flushing an unseeded (empty) doc would
  write an empty file over real content. `loaded` / `loadComplete` gate this.
- **Edits that race the load are buffered** (`dirtyDuringLoad`) and flushed once
  loaded.
- **A failed flush never loses data** — the edit is still live in the `Y.Doc`,
  so the flush is retried (`FLUSH_RETRY_MS = 5000`); on last-disconnect the doc
  is *not* destroyed until its final flush succeeds.
- **A reconnecting client's state wins over a re-seed** (section above) — no
  duplication.

### Optional crash-WAL

With `REDOX_WAL=1`, every update is also written to a LevelDB log
(`YDATA_DIR`, default `./data`) and replayed on load. This is **off by default**
and is only a crash-recovery aid — the markdown files remain canonical. When the
WAL is on it also gives the server a stable Yjs identity across restarts (the
replay is applied before any disk cold-load, ordered by `walReady`).

### Corruption guards

`cold-load` and `flush` are synchronous and block the event loop for their
duration. A pathological document (e.g. one ballooned by an old duplication bug
and still held by a stale client) could pin the loop. Two cheap O(1) guards in
[store.ts](../server/store.ts) prevent that: refuse to **parse** a file over
`MAX_DOC_BYTES` (2 MB) on cold-load, and refuse to **serialize** a fragment over
`MAX_DOC_BLOCKS` (10 000 top-level blocks) on flush. Both log and skip rather
than wedge; a real note is nowhere near these bounds.

---

## 6. Annotations

A side note is an annotation: a text range plus a comment, author, time, color,
and a reply thread (`MyAnnotation` / `StoredAnnotation` in
[annotations/types.ts](../src/annotations/types.ts)).

Two shapes, translated only at the file boundary
([anchoring.ts](../server/anchoring.ts)):

- **Live**: absolute ProseMirror offsets `{ id, from, to, … }`, stored in the
  doc room's `annotations` `Y.Array`. This is exactly what the client
  reads/writes.
- **On disk**: resilient text anchors `{ id, quote, prefix, suffix, posHint, … }`
  in the `.annotations.json` sidecar.

Why anchors and not offsets on disk: a file can be edited (by anyone, including
outside the app) while it's closed. Offsets would silently point at the wrong
text after such an edit. So on load, `anchorsToOffsets` *relocates* each
annotation by searching for its `quote`, disambiguating multiple matches by how
much surrounding context (`prefix`/`suffix`, up to `CONTEXT = 32` chars) agrees
and, as a tiebreak, by proximity to the stored `posHint`. If the quote is gone
entirely, the annotation is marked **orphaned, never dropped** — user data is
never silently lost.

The editor ↔ Yjs direction is `useAnnotationSync`
([annotations/useAnnotationSync.ts](../src/annotations/useAnnotationSync.ts)): a
reactive effect mirrors stored annotations into the editor once content is
ready (and on remote changes); an imperative update listener reads *fresh*
editor state and writes changes back, guarded so a stable state never loops.

Caveat: live offsets are absolute, so under simultaneous edits to the *same*
region two clients' annotations can briefly drift, then self-heal on
convergence. Fine for iterating; not a hardened concurrent-annotation model.

---

## 7. The file index

The sidebar's file list is a `Y.Map<id, FileMeta>` in the `redox:index` room
(`FILES_MAP = "files"`). [index-sync.ts](../server/index-sync.ts) keeps it in
sync with the on-disk `*.md` set, **both directions**:

- **Filesystem → map** (authoritative): a scan of `*.md` is published into the
  map and kept live by `fs.watch` plus a periodic safety rescan. The scan uses
  `git ls-files` semantics so ignored files (e.g. anything under `node_modules`)
  never appear.
- **Map → filesystem** (reflect client intent): the client only mutates this map
  — create, rename, delete — and the server mirrors those to disk + git where
  it's unambiguous: delete → `git rm`, rename → `git mv`, create → an empty
  `.md`. A mutation it can't map safely is ignored and logged, never guessed.

The filesystem is authoritative; the map is a live projection of it.

---

## 8. Wire protocol (rooms and keys)

Defined once in [protocol.ts](../src/shared/protocol.ts), imported by both
sides:

| Room | Holds |
| --- | --- |
| `redox:index` | `Y.Map<id, { id, name, createdAt }>` — the file list (`FILES_MAP`). |
| `redox:doc:<id>` | One document: ProseMirror content (fragment `"prosemirror"`) + an `annotations` `Y.Array`. |

One WebSocket URL path == one room. The relay
([index.ts](../server/index.ts)) speaks the y-protocols **sync** and
**awareness** messages and broadcasts updates to every connection in a room. We
run our own relay because y-websocket v3 ships no server and the available one
pins an incompatible Yjs.

---

## 9. The client layer

- **Room pool** ([collab/rooms.ts](../src/collab/rooms.ts)): one
  `WebsocketProvider` + `Y.Doc` per room, reference-counted so switching files
  (or a React StrictMode double-mount) reuses a live socket. A genuine
  switch-away tears the connection down after a short delay; a re-acquire within
  that window keeps it.
- **File index** ([collab/files.ts](../src/collab/files.ts)): `useFiles()` is a
  `useSyncExternalStore` view of the index `Y.Map`; `createFile` / `renameFile`
  / `deleteFile` mutate it (the server reflects to disk).
- **Active file** ([hooks/useActiveFile.ts](../src/hooks/useActiveFile.ts)):
  the URL hash *is* the selected file id, so a doc is shareable by URL.
- **Editor stack** ([editor/extensions.ts](../src/editor/extensions.ts)): the
  shared content extensions + `AnnotationExtension` + `YjsExtension` (bound to
  the room's provider). `AnnotationExtension`'s `getStyle` returns no inline
  style, so an annotation's color comes from its `.annotation-*` CSS class — the
  same class the side-note card uses.
- **Identity** ([collab/user.ts](../src/collab/user.ts)): a name + color in
  `localStorage`, broadcast via Yjs awareness for cursors and used for git
  commit authorship.

---

## 10. Security / trust model

This is a collaboration tool, not a hardened service:

- **No auth.** Anyone who can reach the server and knows (or guesses) a file id
  can read and edit it.
- **Path traversal is contained** (`assertInsideStore`), and `nameToFileId`
  sanitizes names, so ids can't escape the store.
- **Size guards** bound the synchronous work per document (section 5).

Run it on a trusted network or behind your own auth.

---

## 11. Run, develop, test

```bash
npm install
npm run dev          # Vite (web) + collab server together
# or separately:
npm run dev:web      # Vite only          → http://localhost:5173
npm run server       # collab server only → ws://localhost:1234
```

Configuration (environment variables):

| Var | Default | Meaning |
| --- | --- | --- |
| `REDOX_STORE_DIR` | `./store` | The markdown store (a git repo; the source of truth). |
| `PORT` | `1234` | Collab server port. |
| `VITE_WS_URL` | `ws://<host>:1234` | WebSocket URL the web app connects to. |
| `REDOX_WAL` | unset | Set to `1` to enable the optional LevelDB crash-WAL. |
| `YDATA_DIR` | `./data` | WAL directory (only used when `REDOX_WAL=1`). |

The store is its own git repo: redox runs `git init` on first use and commits
every change, so a document's history is just its file history.

Checks:

```bash
npm run lint              # eslint
npx tsc -b                # typecheck
npm test                  # unit tests (node:test via tsx)
npm run test:integration  # spawns a real server; verifies no cold-load reconnect dup (~12s)
```

The integration test (`server/coldload-reconnect.itest.mjs`) is the regression
test for the duplication bug in section 5; it is intentionally *not* in the fast
`npm test` suite because it spawns a server process.

---

## 12. Open questions / known limitations

- **No auth** (section 10).
- **Concurrent annotations** to the same region can briefly drift before
  self-healing (section 6) — not a hardened model.
- **Task-list checkbox state** does not round-trip through markdown: a GFM task
  list re-parses as a plain bullet list (text preserved, checkbox lost). See the
  serializer note in
  [markdown-serializer.ts](../src/editor/markdown-serializer.ts).
- **Flush is synchronous** (serialize + git). For normal-sized notes this is
  fine; the size guards (section 5) keep a pathological document from wedging the
  loop, but a *legitimately* large document would still pause it briefly.
- The `docs/proposals/` directory holds design notes (e.g. the file-identity
  proposal that motivated the path-id model); they are background, not
  authoritative — this guide is.
