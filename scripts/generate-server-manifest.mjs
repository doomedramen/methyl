#!/usr/bin/env node
// Emits a minimal package.json containing only the server's runtime
// dependencies (the packages esbuild leaves external in `build:server`,
// see package.json), pinned to the exact versions the root
// package-lock.json resolved. Used by the Dockerfile's "server-deps" stage
// so the runtime image's node_modules doesn't have to carry the whole
// app's dependency tree (Next.js, React, editor/UI libs, etc.) — just what
// src/server/main.ts actually requires at runtime.
//
// Keep this list in sync with the --external: flags in the `build:server`
// npm script.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_EXTERNAL_DEPS = [
  "better-sqlite3",
  "loro-crdt",
  "loro-websocket",
  "loro-protocol",
  "loro-adaptors",
  "@loro-dev/flock",
  "chokidar",
];

// Reads package-lock.json from the current working directory (not relative
// to this script's own location), so it works whether run from the repo
// root in dev or from a scratch directory in the Dockerfile's server-deps
// stage, where only package.json/package-lock.json are copied alongside it.
const lockPath = process.argv[3] ?? join(process.cwd(), "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

const dependencies = {};
for (const name of SERVER_EXTERNAL_DEPS) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version) {
    throw new Error(`Could not resolve pinned version for "${name}" from package-lock.json`);
  }
  dependencies[name] = entry.version;
}

const manifest = {
  name: "methyl-server-runtime",
  private: true,
  version: "0.0.0",
  dependencies,
};

const outPath = process.argv[2];
const json = JSON.stringify(manifest, null, 2) + "\n";
if (outPath) {
  writeFileSync(outPath, json);
} else {
  process.stdout.write(json);
}
