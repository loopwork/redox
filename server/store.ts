// Git-backed file store (SERVER-ONLY): files are the source of truth.
//
// On-disk layout (the store root is its own git repo):
//   <root>/<path>.md                  document content as markdown
//   <root>/<path>.annotations.json    sidecar: array of anchored annotations
//
// A document's "id" is its relative path with the .md extension (e.g.
// "notes/architecture.md"); the corresponding room name is "redox:doc:<path>".
// This module owns ALL filesystem + git + anchor-translation logic so the live
// Yjs server (server/index.ts) only deals with Y.Docs.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { getSchema } from "../src/editor/schema";
import {
  PM_FRAGMENT,
  seedYDocFromMarkdown,
  yDocToMarkdown,
} from "../src/editor/ydoc";
import {
  anchorsToOffsets,
  offsetsToAnchors,
  type AnchoredAnnotation,
  type OffsetAnnotation,
} from "./anchoring";

// Wire-level Yjs key, mirrored from src/collab/constants.ts (ANNOTATIONS_ARRAY).
// That client file can't be imported here because it touches `window` /
// `import.meta.env`, which don't exist under the server's Node tsconfig; the two
// must stay in sync (both hard-code "annotations", the y-prosemirror convention
// the client relies on).
const ANNOTATIONS_ARRAY = "annotations";

// Store root: its own git repo. Configurable via REDOX_STORE_DIR (default
// ./store, resolved against the process cwd).
export const STORE_DIR = path.resolve(
  process.env.REDOX_STORE_DIR ?? "./store",
);

// Room name <-> file id (relative path) translation.
const DOC_PREFIX = "redox:doc:";
export function roomToFileId(room: string): string | null {
  return room.startsWith(DOC_PREFIX) ? room.slice(DOC_PREFIX.length) : null;
}

// Map a file id to its on-disk paths. The id already carries `.md`.
function mdPathFor(id: string): string {
  return path.join(STORE_DIR, id);
}
function annotationsPathFor(id: string): string {
  // notes/x.md -> notes/x.annotations.json
  const base = id.endsWith(".md") ? id.slice(0, -".md".length) : id;
  return path.join(STORE_DIR, `${base}.annotations.json`);
}

// Guard against path traversal: the resolved file must stay under STORE_DIR.
function assertInsideStore(p: string): void {
  const rel = path.relative(STORE_DIR, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to access path outside store: ${p}`);
  }
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------
function git(args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", args, {
    cwd: STORE_DIR,
    encoding: "utf8",
  });
  return {
    ok: res.status === 0,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
}

let gitInitialized = false;
// Ensure STORE_DIR exists and is a git repo. Idempotent; cheap after first run.
export function ensureStoreRepo(): void {
  if (gitInitialized) return;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(path.join(STORE_DIR, ".git"))) {
    git(["init", "-q"]);
    // Local identity so commits succeed even on a machine with no global git
    // user configured (CI, fresh containers). Harmless if already set.
    git(["config", "user.email", "redox@localhost"]);
    git(["config", "user.name", "redox"]);
  }
  gitInitialized = true;
}

// Identity of the user a commit should be attributed to. Derived server-side
// from Yjs awareness (the client broadcasts { user: { name, color } }); we only
// use the name and synthesize a local-only email so git is happy.
export interface CommitAuthor {
  name: string;
  email?: string;
}

const DEFAULT_AUTHOR: CommitAuthor = {
  name: "redox",
  email: "redox@localhost",
};

function authorEnv(author?: CommitAuthor): NodeJS.ProcessEnv | undefined {
  const a = author && author.name ? author : undefined;
  if (!a) return undefined;
  // Sanitize the display name into something git accepts; fall back if empty.
  const name = a.name.replace(/[\n\r<>]/g, "").trim() || DEFAULT_AUTHOR.name;
  const email =
    a.email && /^[^\s<>]+@[^\s<>]+$/.test(a.email)
      ? a.email
      : // Synthesize a stable, local-only address from the display name.
        `${name.replace(/\s+/g, ".").toLowerCase()}@redox.local`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function commit(
  paths: string[],
  message: string,
  author?: CommitAuthor,
): boolean {
  git(["add", "--", ...paths]);
  // Only commit if there is something staged (avoids empty-commit errors).
  const status = git(["status", "--porcelain"]);
  if (status.out === "") return false;
  const env = authorEnv(author);
  const res = spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: STORE_DIR,
    encoding: "utf8",
    env,
  });
  return res.status === 0;
}

// ---------------------------------------------------------------------------
// cold-load: disk -> Y.Doc
// ---------------------------------------------------------------------------
// Seed an EXISTING Y.Doc (the live WSSharedDoc) from the on-disk markdown +
// annotations sidecar for `id`. If no markdown file exists the doc is left empty
// (today's behavior). `origin` tags the seed transaction(s) so the server's
// persist/broadcast handlers can recognize them.
//
// CONCURRENCY: cold-load runs asynchronously after the room is created, so a
// client may have already synced its state (or made an edit) into the live doc
// before we get here. Seeding disk content on top of that does NOT clobber it —
// y-prosemirror merges the two XmlFragments, producing duplicated/interleaved
// content (disk text + the live edit jammed together). To avoid corrupting the
// live session we treat an already-populated fragment as authoritative: the
// live room wins and will be flushed back to disk. Cold-load only seeds a doc
// whose content fragment is still empty (the normal first-open case).
//
// Returns true if disk content was actually seeded (the doc was empty), false
// if seeding was skipped because a live session already had content.
export function coldLoad(doc: Y.Doc, id: string, origin: unknown): boolean {
  const mdPath = mdPathFor(id);
  assertInsideStore(mdPath);
  if (!fs.existsSync(mdPath)) return false; // no file: empty doc

  // If a client already populated the content fragment during the async load
  // window, do NOT seed from disk — that would merge disk + live content and
  // corrupt the session. The live edits are canonical; flush will persist them.
  if (doc.getXmlFragment(PM_FRAGMENT).length > 0) return false;

  const md = fs.readFileSync(mdPath, "utf8");
  // 1) content: markdown -> prosemirror fragment in the live doc.
  seedYDocFromMarkdown(doc, md, origin);

  // 2) annotations: anchors -> offsets, seeded into the Y.Array.
  const annPath = annotationsPathFor(id);
  assertInsideStore(annPath);
  let anchors: AnchoredAnnotation[] = [];
  if (fs.existsSync(annPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(annPath, "utf8"));
      if (Array.isArray(parsed)) anchors = parsed as AnchoredAnnotation[];
    } catch {
      // Corrupt sidecar: do not crash the room; start with no annotations.
      anchors = [];
    }
  }
  if (anchors.length === 0) return true;

  const node = pmNodeFromYDoc(doc);
  const offsets = anchorsToOffsets(node, anchors);
  const arr = doc.getArray<OffsetAnnotation>(ANNOTATIONS_ARRAY);
  doc.transact(() => {
    if (arr.length > 0) arr.delete(0, arr.length);
    arr.insert(0, offsets);
  }, origin);
  return true;
}

// ---------------------------------------------------------------------------
// flush: Y.Doc -> disk
// ---------------------------------------------------------------------------
function pmNodeFromYDoc(doc: Y.Doc) {
  const json = yDocToProsemirrorJSON(doc, "prosemirror");
  return getSchema().nodeFromJSON(json as Record<string, unknown>);
}

// Serialize a live Y.Doc to its .md + .annotations.json and commit. Creates
// parent directories as needed. Returns true if anything was written.
// `author` (from Yjs awareness) becomes the git commit author when provided.
export function flush(doc: Y.Doc, id: string, author?: CommitAuthor): boolean {
  ensureStoreRepo();
  const mdPath = mdPathFor(id);
  const annPath = annotationsPathFor(id);
  assertInsideStore(mdPath);
  assertInsideStore(annPath);

  let md: string;
  let anchors: AnchoredAnnotation[];
  try {
    md = yDocToMarkdown(doc);
    const node = pmNodeFromYDoc(doc);
    const offsets = doc
      .getArray<OffsetAnnotation>(ANNOTATIONS_ARRAY)
      .toArray();
    anchors = offsetsToAnchors(node, offsets);
  } catch (err) {
    // Serialization can throw if the doc contains a node with no markdown
    // mapping (e.g. task list / iframe — see step-1 issues). Don't lose the
    // room; skip this flush and let a later edit retry.
    console.error(`flush: failed to serialize ${id}:`, err);
    return false;
  }

  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.mkdirSync(path.dirname(annPath), { recursive: true });

  // Markdown: ensure a single trailing newline (POSIX text file convention).
  const mdOut = md.endsWith("\n") ? md : `${md}\n`;
  fs.writeFileSync(mdPath, mdOut, "utf8");

  // Annotations sidecar: write it when there are annotations; remove a stale
  // sidecar when the last annotation is gone so disk stays in sync.
  const writtenPaths = [mdPath];
  if (anchors.length > 0) {
    fs.writeFileSync(annPath, `${JSON.stringify(anchors, null, 2)}\n`, "utf8");
    writtenPaths.push(annPath);
  } else if (fs.existsSync(annPath)) {
    fs.rmSync(annPath);
    writtenPaths.push(annPath);
  }

  commit(writtenPaths, `redox: update ${id}`, author);
  return true;
}

// Async variant used on graceful paths; mkdir/write/commit are fast enough that
// the sync version above is the workhorse, but expose this for parity.
export async function flushAsync(
  doc: Y.Doc,
  id: string,
  author?: CommitAuthor,
): Promise<boolean> {
  await fsp.mkdir(STORE_DIR, { recursive: true });
  return flush(doc, id, author);
}

// ---------------------------------------------------------------------------
// file index: scan *.md and publish ids for the redox:index Y.Map
// ---------------------------------------------------------------------------
export interface ScannedFile {
  id: string; // relative path incl. .md, e.g. "notes/architecture.md"
  name: string; // display name (basename without extension)
  createdAt: number; // mtime in ms (stable-ish ordering for the sidebar)
}

// Recursively scan STORE_DIR for *.md files (excluding *.annotations.json).
export function scanFiles(): ScannedFile[] {
  ensureStoreRepo();
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const id = path.relative(STORE_DIR, full).split(path.sep).join("/");
        let createdAt = Date.now();
        try {
          createdAt = fs.statSync(full).mtimeMs;
        } catch {
          /* keep default */
        }
        out.push({
          id,
          name: e.name.slice(0, -".md".length),
          createdAt,
        });
      }
    }
  };
  walk(STORE_DIR);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// filesystem mutations (reflecting client index CRUD onto disk + git)
// ---------------------------------------------------------------------------
// The client edits the redox:index files Y.Map; the server mirrors safe changes
// to the git-backed store. All of these are guarded against path traversal and
// only ever touch paths inside STORE_DIR.

// True if `id` looks like a path-keyed file id (what the server publishes),
// rather than the client's UUID. UUIDs never contain "/" or end in ".md".
export function isFileId(id: string): boolean {
  return id.endsWith(".md");
}

// Turn an arbitrary display name into a safe relative *.md path. Strips path
// separators and unsafe characters so a name can never escape the store or
// collide with the annotations sidecar suffix.
export function nameToFileId(name: string, dir = ""): string {
  // Drop path separators and the chars illegal on common filesystems,
  // collapse whitespace, and strip our reserved suffixes. Never emits "/"
  // so the result cannot escape STORE_DIR. Control chars and the
  // Windows-reserved set are removed; letters, digits, spaces are kept.
  const cleaned = name
    .replace(/[\\/]+/g, "-") // no nested dirs from a display name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "") // control + fs-illegal chars
    .replace(/\s+/g, " ") // collapse whitespace runs
    .trim()
    .replace(/\.annotations$/i, "") // avoid clashing with sidecar naming
    .replace(/\.md$/i, "")
    .trim();
  const base = cleaned || "Untitled";
  const rel = dir ? `${dir.replace(/\/+$/, "")}/${base}.md` : `${base}.md`;
  return rel;
}

// Pick an unused file id near `id` by appending " 2", " 3", ... before .md.
function uniqueFileId(id: string): string {
  if (!fs.existsSync(mdPathFor(id))) return id;
  const dir = path.posix.dirname(id) === "." ? "" : path.posix.dirname(id);
  const base = path.posix.basename(id, ".md");
  for (let n = 2; n < 1000; n++) {
    const candidate = dir ? `${dir}/${base} ${n}.md` : `${base} ${n}.md`;
    if (!fs.existsSync(mdPathFor(candidate))) return candidate;
  }
  return id;
}

// Create an empty markdown file for a new client-created entry. Returns the
// (possibly de-duplicated) file id actually created, or null on failure.
export function createEmptyFile(name: string, author?: CommitAuthor): string | null {
  ensureStoreRepo();
  const id = uniqueFileId(nameToFileId(name));
  const mdPath = mdPathFor(id);
  try {
    assertInsideStore(mdPath);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    if (!fs.existsSync(mdPath)) fs.writeFileSync(mdPath, "", "utf8");
    commit([mdPath], `redox: create ${id}`, author);
    return id;
  } catch (err) {
    console.error(`createEmptyFile failed for ${name}:`, err);
    return null;
  }
}

// Rename a path-keyed file (and its annotations sidecar) to a new name in the
// same directory, via `git mv`. Returns the new id, or null on failure/no-op.
export function renameStoreFile(
  id: string,
  newName: string,
  author?: CommitAuthor,
): string | null {
  ensureStoreRepo();
  if (!isFileId(id)) return null;
  const oldMd = mdPathFor(id);
  if (!fs.existsSync(oldMd)) return null;
  const dir = path.posix.dirname(id) === "." ? "" : path.posix.dirname(id);
  const newId = uniqueFileId(nameToFileId(newName, dir));
  if (newId === id) return null; // no actual change
  const newMd = mdPathFor(newId);
  try {
    assertInsideStore(oldMd);
    assertInsideStore(newMd);
    fs.mkdirSync(path.dirname(newMd), { recursive: true });
    const moved: string[] = [];
    // Use git mv so history follows; fall back to a plain rename if git mv
    // fails (e.g. file not yet tracked).
    if (!git(["mv", "--", id, newId]).ok) {
      fs.renameSync(oldMd, newMd);
    }
    moved.push(oldMd, newMd);

    // Move the annotations sidecar alongside, if present.
    const oldAnn = annotationsPathFor(id);
    const newAnn = annotationsPathFor(newId);
    if (fs.existsSync(oldAnn)) {
      assertInsideStore(oldAnn);
      assertInsideStore(newAnn);
      const oldAnnRel = path.relative(STORE_DIR, oldAnn).split(path.sep).join("/");
      const newAnnRel = path.relative(STORE_DIR, newAnn).split(path.sep).join("/");
      if (!git(["mv", "--", oldAnnRel, newAnnRel]).ok) {
        fs.renameSync(oldAnn, newAnn);
      }
      moved.push(oldAnn, newAnn);
    }
    commit(moved, `redox: rename ${id} -> ${newId}`, author);
    return newId;
  } catch (err) {
    console.error(`renameStoreFile failed for ${id}:`, err);
    return null;
  }
}

// Delete a path-keyed file (and its annotations sidecar) via `git rm`. Returns
// true if anything was removed.
export function deleteStoreFile(id: string, author?: CommitAuthor): boolean {
  ensureStoreRepo();
  if (!isFileId(id)) return false;
  const mdPath = mdPathFor(id);
  const annPath = annotationsPathFor(id);
  try {
    assertInsideStore(mdPath);
    assertInsideStore(annPath);
    const removed: string[] = [];
    if (fs.existsSync(mdPath)) {
      if (!git(["rm", "-q", "--", id]).ok) fs.rmSync(mdPath);
      removed.push(mdPath);
    }
    if (fs.existsSync(annPath)) {
      const annRel = path.relative(STORE_DIR, annPath).split(path.sep).join("/");
      if (!git(["rm", "-q", "--", annRel]).ok) fs.rmSync(annPath);
      removed.push(annPath);
    }
    if (removed.length === 0) return false;
    commit(removed, `redox: delete ${id}`, author);
    return true;
  } catch (err) {
    console.error(`deleteStoreFile failed for ${id}:`, err);
    return false;
  }
}
