// Document store operations (SERVER-ONLY): files are the source of truth.
//
// On-disk layout (the store root is its own git repo):
//   <root>/<path>.md                  document content as markdown
//   <root>/<path>.annotations.json    sidecar: array of anchored annotations
//
// This module turns a live Y.Doc into those files and back (cold-load / flush),
// scans the store for the file index, and reflects client index CRUD onto disk.
// Path/id math lives in ./paths; git plumbing in ./git.
import fs from "node:fs";
import path from "node:path";
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
import { ANNOTATIONS_ARRAY } from "../src/shared/protocol";
import {
  STORE_DIR,
  mdPathFor,
  annotationsPathFor,
  assertInsideStore,
  isFileId,
  nameToFileId,
  uniqueFileId,
  toFileId,
} from "./paths";
import { git, ensureStoreRepo, commit, type CommitAuthor } from "./git";

// ---------------------------------------------------------------------------
// cold-load: disk -> Y.Doc
// ---------------------------------------------------------------------------
// Seed an EXISTING Y.Doc (the live WSSharedDoc) from the on-disk markdown +
// annotations sidecar for `id`. If no markdown file exists the doc is left empty.
// `origin` tags the seed transaction(s) so the server's handlers recognize them.
//
// CONCURRENCY: cold-load runs asynchronously after the room is created, so a
// client may have already synced state (or made an edit) into the live doc.
// Seeding disk content on top of that would merge two XmlFragments and corrupt
// the session, so we treat an already-populated fragment as authoritative: the
// live room wins and is flushed back to disk. Cold-load only seeds an empty doc.
//
// Returns true if disk content was seeded, false if skipped (live content / no file).
export function coldLoad(doc: Y.Doc, id: string, origin: unknown): boolean {
  const mdPath = mdPathFor(id);
  assertInsideStore(mdPath);
  if (!fs.existsSync(mdPath)) return false; // no file: empty doc

  // A client populated the fragment during the async load window: don't merge.
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
  const json = yDocToProsemirrorJSON(doc, PM_FRAGMENT);
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
    const offsets = doc.getArray<OffsetAnnotation>(ANNOTATIONS_ARRAY).toArray();
    anchors = offsetsToAnchors(node, offsets);
  } catch (err) {
    // Serialization can throw if the doc contains a node with no markdown
    // mapping. Don't lose the room; skip this flush and let a later edit retry.
    console.error(`flush: failed to serialize ${id}:`, err);
    return false;
  }

  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.mkdirSync(path.dirname(annPath), { recursive: true });

  // Markdown: ensure a single trailing newline (POSIX text file convention).
  fs.writeFileSync(mdPath, md.endsWith("\n") ? md : `${md}\n`, "utf8");

  // Annotations sidecar: write when present; remove a stale sidecar once the
  // last annotation is gone so disk stays in sync.
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

// ---------------------------------------------------------------------------
// file index: scan *.md and publish ids for the redox:index Y.Map
// ---------------------------------------------------------------------------
export interface ScannedFile {
  id: string; // relative path incl. .md, e.g. "notes/architecture.md"
  name: string; // display name (basename without extension)
  createdAt: number; // mtime in ms (stable-ish ordering for the sidebar)
}

// Scan the store for *.md files (excluding *.annotations.json).
//
// We ask git rather than walking the tree ourselves so .gitignore is honored:
//   --cached            files already tracked (staged/committed)
//   --others            untracked files (so brand-new docs show up pre-commit)
//   --exclude-standard  apply .gitignore / .git/info/exclude / global excludes
//   -z                  NUL-separated output (paths with spaces stay intact)
// This keeps ignored trees (e.g. a node_modules/ with its own READMEs) out of
// the index. git emits POSIX, repo-relative paths, which already ARE file ids.
export function scanFiles(): ScannedFile[] {
  ensureStoreRepo();
  const res = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.md",
  ]);
  // git failed: report an empty index rather than fall back to an unfiltered
  // walk that would reintroduce ignored files.
  if (!res.ok) {
    console.error(`scanFiles: git ls-files failed: ${res.out}`);
    return [];
  }

  const out: ScannedFile[] = [];
  const seen = new Set<string>();
  for (const id of res.out.split("\0")) {
    if (!id.endsWith(".md") || seen.has(id)) continue;
    seen.add(id);
    let createdAt: number;
    try {
      createdAt = fs.statSync(path.join(STORE_DIR, id)).mtimeMs;
    } catch {
      continue; // listed but absent on disk (e.g. staged delete): skip
    }
    out.push({ id, name: path.posix.basename(id, ".md"), createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// filesystem mutations (reflecting client index CRUD onto disk + git)
// ---------------------------------------------------------------------------
// The client edits the redox:index files Y.Map; the server mirrors safe changes
// to the git-backed store. All are guarded against path traversal (assertInsideStore).

// Does a file id already exist in the store? (Predicate for uniqueFileId.)
const idExists = (id: string): boolean => fs.existsSync(mdPathFor(id));

// Ensure an empty markdown file exists at exactly `id` (the path the client
// already chose, deduped client-side). No-op if it exists. The client owns id
// selection now, so the server creates the file it was told to — it does not
// re-derive or dedup here.
export function ensureFile(id: string, author?: CommitAuthor): void {
  if (!isFileId(id)) return;
  ensureStoreRepo();
  const mdPath = mdPathFor(id);
  try {
    assertInsideStore(mdPath);
    if (fs.existsSync(mdPath)) return;
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, "", "utf8");
    commit([mdPath], `redox: create ${id}`, author);
  } catch (err) {
    console.error(`ensureFile failed for ${id}:`, err);
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
  const newId = uniqueFileId(nameToFileId(newName, dir), idExists);
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
      if (!git(["mv", "--", toFileId(oldAnn), toFileId(newAnn)]).ok) {
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
      if (!git(["rm", "-q", "--", toFileId(annPath)]).ok) fs.rmSync(annPath);
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
