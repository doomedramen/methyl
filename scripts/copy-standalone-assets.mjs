#!/usr/bin/env node
// `next build` with `output: "standalone"` (next.config.ts) produces a
// self-contained server at `.next/standalone/server.js`, but — per Next's
// own docs (node_modules/next/dist/docs/.../self-hosting.md /
// custom-server.md) — it deliberately does NOT copy `.next/static` or
// `public/` next to it; those have to be layered in by the deploying build.
// The Dockerfile does this itself for the container image; this script does
// the same thing for `npm run build` + `npm run start:server` run directly
// on the host (no Docker), so local runs match production instead of
// 404ing (or, worse, silently falling through to the app's catch-all route
// and serving the HTML shell for every JS/CSS chunk — see the vault never
// booting, unstyled, in a local `start:server` run).
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const standaloneDir = join(root, ".next", "standalone");

if (!existsSync(standaloneDir)) {
  throw new Error(`${standaloneDir} does not exist — run \`next build\` first.`);
}

const targets = [
  { from: join(root, ".next", "static"), to: join(standaloneDir, ".next", "static") },
  { from: join(root, "public"), to: join(standaloneDir, "public") },
];

for (const { from, to } of targets) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
