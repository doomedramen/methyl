#!/usr/bin/env node
/**
 * The version this build reports (spec item 12): NEXT_PUBLIC_APP_VERSION
 * when set (the Docker build passes it), else the release tag on HEAD
 * (`v1.2.3` → `1.2.3`), else `0.0.0-<short sha>`, else `0.0.0-dev`.
 * Prints it when run directly.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function appVersion() {
  const fromEnv = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  const tag = git("describe", "--tags", "--exact-match", "--match", "v[0-9]*");
  if (tag) return tag.replace(/^v/, "");
  const sha = git("rev-parse", "--short=7", "HEAD");
  return sha ? `0.0.0-${sha}` : "0.0.0-dev";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(appVersion());
