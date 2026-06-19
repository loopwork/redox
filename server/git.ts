// Git plumbing for the store repo (SERVER-ONLY). All git invocations run with
// cwd = STORE_DIR. Higher-level store operations (store.ts) call commit() after
// writing files.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { STORE_DIR } from "./paths";

// Run a git subcommand in the store repo. Returns ok + combined output.
export function git(args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", args, { cwd: STORE_DIR, encoding: "utf8" });
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

// Identity a commit should be attributed to. Derived server-side from Yjs
// awareness (the client broadcasts { user: { name, color } }); we use the name
// and synthesize a local-only email so git is happy.
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

// Stage `paths` and commit with `message`. No-op (returns false) when nothing is
// staged, so callers can flush unconditionally without empty-commit errors.
export function commit(
  paths: string[],
  message: string,
  author?: CommitAuthor,
): boolean {
  git(["add", "--", ...paths]);
  const status = git(["status", "--porcelain"]);
  if (status.out === "") return false;
  const res = spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: STORE_DIR,
    encoding: "utf8",
    env: authorEnv(author),
  });
  return res.status === 0;
}
