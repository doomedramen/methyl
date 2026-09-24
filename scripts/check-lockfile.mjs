// npm is this project's only package manager (see "packageManager" in
// package.json). A second lockfile drifts silently, so fail if one appears.
import { existsSync } from "node:fs";

const foreign = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].filter((f) => existsSync(f));
if (foreign.length > 0) {
  console.error(`Only package-lock.json is allowed; remove: ${foreign.join(", ")}`);
  process.exit(1);
}
if (!existsSync("package-lock.json")) {
  console.error("package-lock.json is missing; run npm install.");
  process.exit(1);
}
