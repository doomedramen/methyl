/**
 * This build's version (spec item 12): the release tag, or `0.0.0-<sha>`
 * for untagged builds. Inlined at build time (next.config.ts for the app,
 * scripts/build-server.mjs for the server).
 */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0-dev";

/** `major.minor` of a version string, or null if it isn't one. */
export function majorMinor(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Do the app and the server differ in a way worth telling the user? Only
 * when both are releases (untagged builds are 0.0.0) and major.minor differ.
 */
export function versionsDiffer(app: string, server: string): boolean {
  const a = majorMinor(app);
  const b = majorMinor(server);
  if (!a || !b || a === "0.0" || b === "0.0") return false;
  return a !== b;
}
