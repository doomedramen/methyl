#!/usr/bin/env node
/**
 * Copy the packages the server bundle leaves external (see build-server.mjs)
 * and their production dependencies into a runtime node_modules, trimmed to
 * what Node loads on linux-x64 (spec item 19). Next's own runtime files come
 * from .next/standalone; this adds the server's.
 *
 *   node scripts/copy-server-externals.mjs <from node_modules> <to node_modules>
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SERVER_EXTERNALS } from "./server-externals.mjs";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: copy-server-externals.mjs <from node_modules> <to node_modules>");
  process.exit(2);
}

/** Files a package doesn't need at runtime here, relative to its folder. */
const PRUNE = {
  // Prebuilt binaries for every platform, plus SQLite's C sources.
  "better-sqlite3": (dir) => {
    for (const sub of ["deps", "src", "build"]) rmSync(join(dir, sub), { recursive: true, force: true });
    const keep = new Set(["linux-x64.node", "linux-arm64.node"]);
    const prebuilds = join(dir, "prebuilds");
    if (existsSync(prebuilds)) {
      for (const f of readdirSafe(prebuilds)) if (!keep.has(f)) rmSync(join(prebuilds, f), { force: true });
    }
  },
  // Builds for browsers and bundlers; Node loads loro-crdt/nodejs.
  "loro-crdt": (dir) => {
    for (const sub of ["browser", "bundler", "web", "base64"]) rmSync(join(dir, sub), { recursive: true, force: true });
  },
};

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const copied = new Set();
function copy(name) {
  if (copied.has(name) || name.startsWith("@types/")) return;
  copied.add(name);
  const source = join(from, name);
  if (!existsSync(source)) throw new Error(`${name} is not installed in ${from}`);
  const target = join(to, name);
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
  PRUNE[name]?.(target);
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    // A dependency nested under the package came along with it.
    if (!existsSync(join(source, "node_modules", dep))) copy(dep);
  }
}

for (const name of SERVER_EXTERNALS.filter((n) => n !== "next")) copy(name);
console.log(`copied ${copied.size} packages: ${[...copied].sort().join(", ")}`);
