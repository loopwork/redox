// scanFiles() must honor .gitignore — ignored trees (e.g. node_modules, which
// ships hundreds of its own README.md / CHANGELOG.md files) must NOT leak into
// the file index. We point the store at THIS repo (a git repo whose
// node_modules is gitignored) and assert the scan only sees tracked docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scanFiles skips gitignored markdowns (node_modules)", async () => {
  // STORE_DIR is read from the env at module-eval time, so set it before the
  // dynamic import of store.ts (which transitively imports paths.ts).
  process.env.REDOX_STORE_DIR = repoRoot;
  const { scanFiles } = await import("./store.ts");

  const ids = scanFiles().map((f) => f.id);

  // Sanity: tracked repo markdown is present.
  assert.ok(ids.includes("README.md"), "expected README.md in the scan");

  // The point of the test: node_modules has 800+ markdowns but is gitignored,
  // so none of them may appear in the index.
  const leaked = ids.filter((id) => id.startsWith("node_modules/"));
  assert.deepEqual(
    leaked,
    [],
    `gitignored node_modules markdowns leaked into scan: ${leaked
      .slice(0, 3)
      .join(", ")}${leaked.length > 3 ? " …" : ""}`,
  );

  // And ids are real .md paths (no annotations sidecars).
  assert.ok(
    ids.every((id) => id.endsWith(".md")),
    "scan returned a non-.md id",
  );
});
