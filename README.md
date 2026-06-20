# redox

A multi-file, collaborative rich-text editor with side-note annotations. Open a document by URL and edit it together in real time — live cursors, colored highlights, and threaded notes.

The defining idea: **your documents are plain markdown files in a git repository.** The live collaborative session (Yjs over WebSocket) is layered on top, and the files are always the source of truth.

## Run

```bash
npm install
npm run dev          # web app (Vite) + collab server together
```

Open the printed Vite URL, click **+ New** to create a document, and share the URL — anyone who opens it joins the same live session.

Run the two processes separately if you prefer:

```bash
npm run dev:web      # web only          → http://localhost:5173
npm run server       # collab server only → ws://localhost:1234
```

The markdown store defaults to `./store` (set `REDOX_STORE_DIR` to change it). It is a git repo; redox initializes it and commits every change, so each document's history is its file history.

## Documentation

- [User Guide](docs/user-guide.md) — using the app: writing, highlights and side notes, tables, ⌘K quick-switch, real-time collaboration, sharing.
- [Developer Guide](docs/developer-guide.md) — the architecture and the *why*: files-as-source-of-truth, the path-based file identity, the markdown ↔ ProseMirror ↔ Yjs bridge, the cold-load / flush / teardown lifecycle and its data-loss invariants, annotation anchoring, the file index, and how to run / develop / test.

## Status

Pre-release and unauthenticated — anyone who can reach the server and knows a document's id can edit it. Run it on a trusted network or behind your own auth. See the developer guide for known limitations and open questions.
