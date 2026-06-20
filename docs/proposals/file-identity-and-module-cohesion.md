# Proposal: Collapse the file-identity seam to one id (+ module cohesion notes)

Status: draft / for discussion Context: `md-json-gateway` branch. **Not shipped** — no users, no on-disk data to migrate, no legacy clients. We can change anything. Lens: *Simple Made Easy* (Hickey) — prefer the design with the **fewest interleaved concepts**, even if a more familiar/convenient one exists. "Simple" = un-braided (one role per construct); the enemy is *complecting* (twisting two things together).

---

## 1. The file-identity seam

### 1.1 Root cause (stated as complexity, not as a bug)

There are **two id schemes for one thing**:

- **Client**: a random `crypto.randomUUID()` per file (`src/collab/files.ts`), room `redox:doc:<uuid>`.
- **Server**: the store-relative path, e.g. `notes/architecture.md`, room `redox:doc:notes/architecture.md`.

Everything painful downstream — the `index-sync` UUID→path reconciliation dance, orphan files, the stranded editor, and every "fix" we sketched (migrate the editor, a create-handshake, a uuid↔path map) — is **incidental complexity that exists only because two ids are braided together**. The UUID is a vestige of the original localStorage prototype; the gateway already made the *path* the source of truth. The client just never caught up.

> The simple move is not to reconcile the two ids better. It's to **have one id.**

### 1.2 Current behaviour / failure modes (why the braid hurts)

Click **+ New**, type before the sidebar refreshes:

1. Client opens `redox:doc:<uuid>`. Server `roomToFileId` returns `"<uuid>"` — truthy, not `.md` — so the gateway treats it as file-backed and flushes to `<store>/<uuid>` (no extension): an **orphan**. `index-sync` separately creates an empty `Untitled.md` and drops the UUID key.
2. The editor stays on the UUID room. Opening the path entry cold-loads the empty `Untitled.md`; the typed content + annotations are orphaned and lost.

Failure modes F1 stranded content · F2 orphan files · F3 orphan annotations · F4 rename no-ops on a UUID key · F5 duplicate files. **All five are symptoms of the two-id braid** — none exist if the client and server share one id.

### 1.3 The simple design: one identity = the path

Collapse to a single concept: **a file's identity is its store-relative path.** The client adopts it; the UUID disappears.

What this *removes* (the point — simplicity is subtractive here):

- ✂️ UUID generation (`crypto.randomUUID` in `createFile`).
- ✂️ The `index-sync` UUID→path reconciliation branch (create-empty-then-drop-key).
- ✂️ Orphan rooms/files (a non-`.md` room never exists, so nothing to clean up).
- ✂️ Any migration / mapping / handshake — none are needed.

The index becomes purely `scanFiles()` → published; there is nothing to reconcile because the client already names files the way the store does.

**Create flow** (no new machinery):

```
createFile(name):
  id = uniqueInIndex(nameToFileId(name))   // pure fn + dedup vs the in-memory index
  open room redox:doc:<id>
```

- `nameToFileId` is **pure string→path** logic. Move it into `src/shared/protocol.ts` (the DOM-free module both tiers already import). One function, one definition, used by client and server → **no drift by construction** (same pattern that killed the duplicated wire constants).
- Dedup happens **locally against the index the client already holds** (`useFiles` snapshot) — `Untitled.md`, `Untitled 2.md`, … — so the room the client opens is already unique. No server round-trip, no "server deduped, follow my id" step.
- The server keeps `uniqueFileId` as an idempotent safety net, but in the normal path it just creates the file the client named.

Identity = location in the store — the **same model as git, Obsidian, the filesystem itself**. That alignment is what makes it simple: we stop inventing an identity and reuse the one the substrate already has.

### 1.4 Honest tradeoffs of one-id-as-path

These are *inherent* to the model (not incidental), so we accept them deliberately:

| Tradeoff | Assessment | |---|---| | **Rename changes the id** (file moves; `git mv`). Cross-note links would need updating. | Inherent to a path-addressed store; identical to Obsidian/markdown KBs. A stable surrogate id would require a uuid↔path map = the drift we're removing. Accept it; link-rewriting is a future feature, not an identity problem. | | **Concurrent "+ New" of the same name** on two clients → both compute `Untitled.md` → same room → Yjs merges into one file. | Rare; no data loss (CRDT merge). Acceptable. (A surrogate id wouldn't help: they'd still be two files the user must reconcile.) | | Client now owns name→path sanitization. | It's a shared pure function, so this is not duplication — it's one definition imported twice. |

### 1.5 The other options *add* concepts — rejected on simplicity

Each alternative keeps two ids (or adds coordination), i.e. complects:

- **B2 — server create-handshake.** Adds a request/reply protocol: an intents map, a reply channel, async `createFile`, pending/timeout state. More concepts, and it braids "create a file" with "do a round-trip." (Pre-ship, the only thing it buys — server as sole id authority — is already free once `nameToFileId` is shared.)
- **C1 — migrate the open editor.** Exists *only* to bridge two ids: detect the uuid→path swap, transfer `Y.Doc` state between rooms, re-point the hash, avoid double-flush. Pure incidental complexity; deleting the UUID deletes the need.
- **C2 — uuid as durable id + map.** Two ids *plus* a mapping table. Either uuid-named files (opaque store, defeats the goal) or a `uuid↔path` map (reintroduces drift). The most complected option.

All three were artifacts of treating the seam as "needs reconciliation." It doesn't — it needs *removal*.

### 1.6 One guardrail (an invariant, not a patch)

Keep a single defensive invariant in the gateway: **only** `.md` rooms are file-backed.

```ts
this.fileId = isFileId(id) ? id : null;   // was roomToFileId(name)
```

With the UUID gone there are no stray rooms to catch in normal use, but this makes "a room is file-backed iff its id is a path" a *checked property* rather than an assumption — a malformed room name can never write a bare orphan. It's one line and it states the model, so it stays.

### 1.7 Recommendation

**Adopt one identity = the path. Delete the UUID.** Concretely:

1. `src/shared/protocol.ts`: add `nameToFileId` (pure; moved from `server/paths.ts`, which re-exports it).
2. `src/collab/files.ts`: `createFile(name)` = `nameToFileId(name)` deduped against the in-memory index; no UUID.
3. `server/index-sync.ts`: drop the UUID reconciliation branch; `add` now receives a path id (create if missing); the rest is just scan→publish.
4. `server/gateway.ts`: the `isFileId` invariant (1.6).
5. Delete the migration/handshake/mapping ideas — not needed.

Net change in **concept count: fewer than today** (one id; no reconciliation; no orphan handling). That is the Simple-Made-Easy win, and being unshipped means we pay zero migration cost to get it.

---

## 2. Module cohesion

Through the same lens (one concept per construct):

### 2.1 `src/editor/markdown.ts` (\~349 lines) — **SPLIT**

It braids three independent concepts: the markdown-it tokenizer (+underline plugin), the `MarkdownParser` (md→PM), and the `MarkdownSerializer` (PM→md). Parser and serializer share **no logic and never call each other**; the tokenizer only exists to support the serializer's `<u>` output. That's three things twisted into one file — exactly what "simple" argues against.

```
src/editor/
  markdown.ts            # public API + lazy singletons, re-exports
  markdown-parser.ts     # buildParser
  markdown-serializer.ts # buildSerializer + helpers
  markdown-tokenizer.ts  # underlineHtmlPlugin + buildTokenizer
```

Each \~80 lines, independently testable. Public API unchanged. Low stakes, but it *is* a decomplecting move, so do it next time the file is touched.

### 2.2 `server/anchoring.ts` (\~236 lines) — **LEAVE**

This is already **one concept**: translate annotations between live offsets and on-disk quote-anchors (with the fuzzy relocation that requires). `buildTextMap` and the matcher are private infrastructure for that single job; both direction functions use the text map. Splitting would add a file with one internal consumer — it wouldn't separate two concepts, just scatter one. Leaving it together is the simple choice. (Minor: if `buildTextMap`'s export has no external user, make it private.)

---

## Appendix — touch points (one-id-as-path)

- `src/shared/protocol.ts` — add pure `nameToFileId`.
- `server/paths.ts` — re-export `nameToFileId`; keep `uniqueFileId` (server safety net).
- `src/collab/files.ts` — `createFile` = deduped `nameToFileId`, no UUID; dedup vs the index snapshot.
- `server/index-sync.ts` — remove the UUID branch; `add` = create-if-missing by path.
- `server/gateway.ts` — `fileId = isFileId(id) ? id : null`.
- (No new modules, no migration, no handshake.)

# Proposal: Collapse the file-identity seam to one id (+ module cohesion notes)

Status: draft / for discussion Context: `md-json-gateway` branch. **Not shipped** — no users, no on-disk data to migrate, no legacy clients. We can change anything. Lens: *Simple Made Easy* (Hickey) — prefer the design with the **fewest interleaved concepts**, even if a more familiar/convenient one exists. "Simple" = un-braided (one role per construct); the enemy is *complecting* (twisting two things together).

---

## 1. The file-identity seam

### 1.1 Root cause (stated as complexity, not as a bug)

There are **two id schemes for one thing**:

- **Client**: a random `crypto.randomUUID()` per file (`src/collab/files.ts`), room `redox:doc:<uuid>`.
- **Server**: the store-relative path, e.g. `notes/architecture.md`, room `redox:doc:notes/architecture.md`.

Everything painful downstream — the `index-sync` UUID→path reconciliation dance, orphan files, the stranded editor, and every "fix" we sketched (migrate the editor, a create-handshake, a uuid↔path map) — is **incidental complexity that exists only because two ids are braided together**. The UUID is a vestige of the original localStorage prototype; the gateway already made the *path* the source of truth. The client just never caught up.

> The simple move is not to reconcile the two ids better. It's to **have one id.**

### 1.2 Current behaviour / failure modes (why the braid hurts)

Click **+ New**, type before the sidebar refreshes:

1. Client opens `redox:doc:<uuid>`. Server `roomToFileId` returns `"<uuid>"` — truthy, not `.md` — so the gateway treats it as file-backed and flushes to `<store>/<uuid>` (no extension): an **orphan**. `index-sync` separately creates an empty `Untitled.md` and drops the UUID key.
2. The editor stays on the UUID room. Opening the path entry cold-loads the empty `Untitled.md`; the typed content + annotations are orphaned and lost.

Failure modes F1 stranded content · F2 orphan files · F3 orphan annotations · F4 rename no-ops on a UUID key · F5 duplicate files. **All five are symptoms of the two-id braid** — none exist if the client and server share one id.

### 1.3 The simple design: one identity = the path

Collapse to a single concept: **a file's identity is its store-relative path.** The client adopts it; the UUID disappears.

What this *removes* (the point — simplicity is subtractive here):

- ✂️ UUID generation (`crypto.randomUUID` in `createFile`).
- ✂️ The `index-sync` UUID→path reconciliation branch (create-empty-then-drop-key).
- ✂️ Orphan rooms/files (a non-`.md` room never exists, so nothing to clean up).
- ✂️ Any migration / mapping / handshake — none are needed.

The index becomes purely `scanFiles()` → published; there is nothing to reconcile because the client already names files the way the store does.

**Create flow** (no new machinery):

```
createFile(name):
  id = uniqueInIndex(nameToFileId(name))   // pure fn + dedup vs the in-memory index
  open room redox:doc:<id>
```

- `nameToFileId` is **pure string→path** logic. Move it into `src/shared/protocol.ts` (the DOM-free module both tiers already import). One function, one definition, used by client and server → **no drift by construction** (same pattern that killed the duplicated wire constants).
- Dedup happens **locally against the index the client already holds** (`useFiles` snapshot) — `Untitled.md`, `Untitled 2.md`, … — so the room the client opens is already unique. No server round-trip, no "server deduped, follow my id" step.
- The server keeps `uniqueFileId` as an idempotent safety net, but in the normal path it just creates the file the client named.

Identity = location in the store — the **same model as git, Obsidian, the filesystem itself**. That alignment is what makes it simple: we stop inventing an identity and reuse the one the substrate already has.

### 1.4 Honest tradeoffs of one-id-as-path

These are *inherent* to the model (not incidental), so we accept them deliberately:

| Tradeoff | Assessment | |---|---| | **Rename changes the id** (file moves; `git mv`). Cross-note links would need updating. | Inherent to a path-addressed store; identical to Obsidian/markdown KBs. A stable surrogate id would require a uuid↔path map = the drift we're removing. Accept it; link-rewriting is a future feature, not an identity problem. | | **Concurrent "+ New" of the same name** on two clients → both compute `Untitled.md` → same room → Yjs merges into one file. | Rare; no data loss (CRDT merge). Acceptable. (A surrogate id wouldn't help: they'd still be two files the user must reconcile.) | | Client now owns name→path sanitization. | It's a shared pure function, so this is not duplication — it's one definition imported twice. |

### 1.5 The other options *add* concepts — rejected on simplicity

Each alternative keeps two ids (or adds coordination), i.e. complects:

- **B2 — server create-handshake.** Adds a request/reply protocol: an intents map, a reply channel, async `createFile`, pending/timeout state. More concepts, and it braids "create a file" with "do a round-trip." (Pre-ship, the only thing it buys — server as sole id authority — is already free once `nameToFileId` is shared.)
- **C1 — migrate the open editor.** Exists *only* to bridge two ids: detect the uuid→path swap, transfer `Y.Doc` state between rooms, re-point the hash, avoid double-flush. Pure incidental complexity; deleting the UUID deletes the need.
- **C2 — uuid as durable id + map.** Two ids *plus* a mapping table. Either uuid-named files (opaque store, defeats the goal) or a `uuid↔path` map (reintroduces drift). The most complected option.

All three were artifacts of treating the seam as "needs reconciliation." It doesn't — it needs *removal*.

### 1.6 One guardrail (an invariant, not a patch)

Keep a single defensive invariant in the gateway: **only** `.md` rooms are file-backed.

```ts
this.fileId = isFileId(id) ? id : null;   // was roomToFileId(name)
```

With the UUID gone there are no stray rooms to catch in normal use, but this makes "a room is file-backed iff its id is a path" a *checked property* rather than an assumption — a malformed room name can never write a bare orphan. It's one line and it states the model, so it stays.

### 1.7 Recommendation

**Adopt one identity = the path. Delete the UUID.** Concretely:

1. `src/shared/protocol.ts`: add `nameToFileId` (pure; moved from `server/paths.ts`, which re-exports it).
2. `src/collab/files.ts`: `createFile(name)` = `nameToFileId(name)` deduped against the in-memory index; no UUID.
3. `server/index-sync.ts`: drop the UUID reconciliation branch; `add` now receives a path id (create if missing); the rest is just scan→publish.
4. `server/gateway.ts`: the `isFileId` invariant (1.6).
5. Delete the migration/handshake/mapping ideas — not needed.

Net change in **concept count: fewer than today** (one id; no reconciliation; no orphan handling). That is the Simple-Made-Easy win, and being unshipped means we pay zero migration cost to get it.

---

## 2. Module cohesion

Through the same lens (one concept per construct):

### 2.1 `src/editor/markdown.ts` (\~349 lines) — **SPLIT**

It braids three independent concepts: the markdown-it tokenizer (+underline plugin), the `MarkdownParser` (md→PM), and the `MarkdownSerializer` (PM→md). Parser and serializer share **no logic and never call each other**; the tokenizer only exists to support the serializer's `<u>` output. That's three things twisted into one file — exactly what "simple" argues against.

```
src/editor/
  markdown.ts            # public API + lazy singletons, re-exports
  markdown-parser.ts     # buildParser
  markdown-serializer.ts # buildSerializer + helpers
  markdown-tokenizer.ts  # underlineHtmlPlugin + buildTokenizer
```

Each \~80 lines, independently testable. Public API unchanged. Low stakes, but it *is* a decomplecting move, so do it next time the file is touched.

### 2.2 `server/anchoring.ts` (\~236 lines) — **LEAVE**

This is already **one concept**: translate annotations between live offsets and on-disk quote-anchors (with the fuzzy relocation that requires). `buildTextMap` and the matcher are private infrastructure for that single job; both direction functions use the text map. Splitting would add a file with one internal consumer — it wouldn't separate two concepts, just scatter one. Leaving it together is the simple choice. (Minor: if `buildTextMap`'s export has no external user, make it private.)

---

## Appendix — touch points (one-id-as-path)

- `src/shared/protocol.ts` — add pure `nameToFileId`.
- `server/paths.ts` — re-export `nameToFileId`; keep `uniqueFileId` (server safety net).
- `src/collab/files.ts` — `createFile` = deduped `nameToFileId`, no UUID; dedup vs the index snapshot.
- `server/index-sync.ts` — remove the UUID branch; `add` = create-if-missing by path.
- `server/gateway.ts` — `fileId = isFileId(id) ? id : null`.
- (No new modules, no migration, no handshake.)
