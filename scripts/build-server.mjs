#!/usr/bin/env node
/**
 * Bundle the server entry point (src/server/main.ts) into dist/server.cjs,
 * with the app version baked in (see app-version.mjs).
 */
import { build } from "esbuild";
import { appVersion } from "./app-version.mjs";
import { SERVER_EXTERNALS } from "./server-externals.mjs";

const version = appVersion();
await build({
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/server.cjs",
  external: SERVER_EXTERNALS,
  alias: { "@": "./src" },
  define: { "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(version) },
  logLevel: "info",
});
console.log(`server bundle version ${version}`);
