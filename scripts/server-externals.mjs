/**
 * Packages the server bundle doesn't include (native code, WASM, or Next
 * itself). build-server.mjs leaves them external; the Docker image copies
 * them next to the bundle (copy-server-externals.mjs), Next from its
 * standalone output.
 */
export const SERVER_EXTERNALS = ["better-sqlite3", "loro-crdt", "loro-websocket", "loro-protocol", "chokidar", "next"];
