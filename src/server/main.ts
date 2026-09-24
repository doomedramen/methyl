import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { Socket } from "net";
import { join } from "path";
import next from "next";
import { VaultHost } from "@/lib/server/vault-host";
import { AuthLimiter, clientAddress } from "@/lib/server/auth";
import { runBackupCommand } from "./backup";

const PORT = Number(process.env.METHYL_PORT ?? 8080);
const HOST = process.env.METHYL_HOST ?? "0.0.0.0";
// Multi-vault: every sub-folder of METHYL_VAULTS_PATH is a vault. Without
// it, METHYL_VAULT_PATH is served as the single vault "default".
const VAULTS_PATH = process.env.METHYL_VAULTS_PATH || undefined;
const VAULT_PATH = process.env.METHYL_VAULT_PATH ?? "/vault";
const WATCH = process.env.METHYL_WATCH !== "false";
const AUTH_TOKEN = process.env.METHYL_AUTH_TOKEN;
// Only set when a trusted reverse proxy (e.g. Nginx Proxy Manager) sits in
// front: the failed-auth limiter then keys on X-Forwarded-For.
const TRUST_PROXY = process.env.METHYL_TRUST_PROXY === "true";
const MAX_ASSET_BYTES = process.env.METHYL_MAX_ASSET_BYTES
  ? Number(process.env.METHYL_MAX_ASSET_BYTES)
  : undefined;
// Project root (the dir containing `.next`) — the bundled server lives in
// `dist/`, so the app is one level up by default; overridable for running
// against a differently-located checkout (e.g. a container that mounts the
// build elsewhere).
const APP_DIR = process.env.METHYL_APP_DIR ?? join(__dirname, "..");
// CORS for /api + /healthz: only needed when the browser app is served from
// a different origin than this server (e.g. a separate frontend host).
// Same-origin requests need no CORS headers at all, so the default is to
// send none. Set a comma-separated allow-list to opt in.
const ALLOWED_ORIGINS = (process.env.METHYL_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
}

function requireAuthToken(): void {
  if (AUTH_TOKEN) return;
  console.error(
    "[methyl] METHYL_AUTH_TOKEN is required. Set it to a long random secret " +
      "(e.g. `openssl rand -hex 32`) — clients and this server must agree on it.",
  );
  process.exit(1);
}


async function main() {
  // One limiter for every authenticated entry point: HTTP API and sync joins.
  const limiter = new AuthLimiter();
  // One room server per vault; this server's own upgrade handler (below)
  // routes sync sockets to them — one port for everything.
  const vaults = new VaultHost({
    vaultsPath: VAULTS_PATH,
    vaultPath: VAULT_PATH,
    authToken: AUTH_TOKEN!,
    watch: WATCH,
    limiter,
    trustProxy: TRUST_PROXY,
    maxAssetBytes: MAX_ASSET_BYTES,
  });
  await vaults.start();

  // In-process Next.js (custom-server API). `dev: false` — this entrypoint
  // is the production path; `npm run dev` already serves the dev server.
  const app = next({ dev: false, dir: APP_DIR });
  const handle = app.getRequestHandler();
  await app.prepare();

  // Next installs a catch-all upgrade listener lazily from getRequestHandler.
  // In production Methyl owns the only WebSocket endpoint, so keep this
  // listener and remove Next's competing one after it is registered.
  // Otherwise a browser WebSocket is closed before the Loro handshake.
  function handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    // An address locked out by failed auth may not open sync sockets.
    if (limiter.retryAfterMs(clientAddress(req, TRUST_PROXY)) > 0) {
      clientSocket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    vaults.handleUpgrade(req, clientSocket, head);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz" || url.pathname.startsWith("/api/")) {
      applyCors(req, res);
    }

    if (req.method === "OPTIONS" && (url.pathname === "/healthz" || url.pathname.startsWith("/api/"))) {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, methyl: true }));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      vaults.handleApi(req, res);
      return;
    }

    void handle(req, res);
    for (const listener of server.listeners("upgrade")) {
      if (listener !== handleUpgrade) {
        server.removeListener(
          "upgrade",
          listener as Parameters<Server["removeListener"]>[1],
        );
      }
    }
  });

  // Sync WebSockets go straight to the room server.
  server.on("upgrade", handleUpgrade);

  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  console.log(
    `[methyl] listening on http://${HOST}:${PORT} ` +
      (VAULTS_PATH ? `(vaults: ${VAULTS_PATH})` : `(vault: ${VAULT_PATH})`),
  );

  const shutdown = async (signal: string) => {
    console.log(`[methyl] received ${signal}, shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vaults.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const command = process.argv[2];
if (command === "backup" || command === "restore") {
  void runBackupCommand(command, process.argv.slice(3), { vaultsPath: VAULTS_PATH, vaultPath: VAULT_PATH })
    .then((code) => process.exit(code));
} else {
  requireAuthToken();
  main().catch((err) => {
    console.error("[methyl] fatal error during startup:", err);
    process.exit(1);
  });
}
