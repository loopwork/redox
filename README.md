# redox

A multi-file, collaborative rich-text editor with side-note annotations.
Documents are stored on a server and edited in real time over [Yjs](https://yjs.dev/);
multiple people can open the same file (via its URL) and see each other's edits
and cursors live.

## Stack

- **Editor** — [Remirror](https://remirror.io/) (ProseMirror) with the WYSIWYG
  preset, the annotation extension, and `@remirror/extension-yjs` for real-time sync.
- **Collaboration** — Yjs documents synced over WebSocket. Document content,
  annotations, and the file list are all CRDTs, so they merge without conflicts.
- **Server** — a small TypeScript Yjs WebSocket server (`server/index.ts`) that
  persists every document to LevelDB on disk.

## Run

```bash
npm install
npm run dev        # starts the web app (Vite) AND the collab server together
```

Open the printed Vite URL. Create a file with **+ New**, then share the URL
(including the `#<file-id>` hash) — anyone who opens it joins the same live session.

Individual processes, if you want them separately:

```bash
npm run dev:web    # Vite only (http://localhost:5173)
npm run server     # collab server only (ws://localhost:1234)
```

Server config via env vars: `PORT` (default `1234`), `YDATA_DIR` (default `./data`,
git-ignored). The web app connects to `ws://<host>:1234` by default; override with
`VITE_WS_URL`.

## How it fits together

- `server/index.ts` — Yjs WebSocket server. One URL path = one Yjs document
  ("room"). Rooms are loaded from LevelDB on first connect and unloaded when the
  last client leaves; all updates are persisted.
- `src/collab.ts` — client connection layer. Reference-counted room connections,
  the shared **file index** (`redox:index`, a collaborative `Y.Map` of files),
  file CRUD, and the local user identity used for awareness cursors.
- `src/App.tsx` — UI. A file sidebar, the active file in the URL hash, and the
  per-file editor. `AnnotationSync` mirrors annotations between the editor and the
  file's Yjs document so they persist and sync alongside the text.

### Rooms

| Room              | Holds                                                |
| ----------------- | ---------------------------------------------------- |
| `redox:index`     | `Y.Map` of `{ id, name, createdAt }` — the file list |
| `redox:doc:<id>`  | one file: ProseMirror content + `annotations` array  |

## Notes & limitations

- Annotation positions are stored as absolute offsets. Under simultaneous edits
  to the same region they can briefly drift, then self-heal once the documents
  converge — fine for iterating, not a hardened concurrent-annotation model.
- No auth: anyone who can reach the server and knows a file id can edit it.
- The `data/` LevelDB directory is the source of truth for persistence; delete it
  to reset all documents.
