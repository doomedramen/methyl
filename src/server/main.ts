import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { connect as netConnect, type Socket } from "net";
import { join } from "path";
import next from "next";
import { createSyncServer, createHttpApi } from "@/lib/server/sync-server";

const PORT = Number(process.env.METHYL_PORT ?? 8080);
const HOST = process.env.METHYL_HOST ?? "0.0.0.0";
const VAULT_PATH = process.env.METHYL_VAULT_PATH ?? "/vault";
const WATCH = process.env.METHYL_WATCH !== "false";
const AUTH_TOKEN = process.env.METHYL_AUTH_TOKEN;
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

if (!AUTH_TOKEN) {
  console.error(
    "[methyl] METHYL_AUTH_TOKEN is required. Set it to a long random secret " +
      "(e.g. `openssl rand -hex 32`) — clients and this server must agree on it.",
  );
  process.exit(1);
}

/**
 * loro-websocket's SimpleServer always binds its own `ws` server to a
 * host:port (see node_modules/loro-websocket/dist/server/index.js) — it has
 * no "attach to an existing http.Server" mode. To present ONE external port
 * to the outside world while reusing SimpleServer unmodified, it's bound to
 * an internal, loopback-only port, and raw WS upgrade requests received on
 * the public port are proxied byte-for-byte over a local TCP connection.
 *
 * Everything else runs in-process: this server hosts the sync HTTP API and
 * the Next.js app directly (via `next()` — the custom-server API, which
 * `output: "standalone"` forbids). No standalone build, no child process, no
 * reverse proxy for ordinary HTTP.
 */
const INTERNAL_WS_PORT = Number(process.env.METHYL_INTERNAL_WS_PORT ?? PORT + 10000);

async function main() {
  const syncServer = createSyncServer({
    port: INTERNAL_WS_PORT,
    host: "127.0.0.1",
    vaultPath: VAULT_PATH,
    authToken: AUTH_TOKEN!,
    watch: WATCH,
  });

  await syncServer.start();

  const assetDir = `${VAULT_PATH}/.adhd/server/assets`;
  const apiHandler = createHttpApi({ store: syncServer.store, authToken: AUTH_TOKEN!, assetDir });

  // In-process Next.js (custom-server API). `dev: false` — this entrypoint
  // is the production path; `npm run dev` already serves the dev server.
  const app = next({ dev: false, dir: APP_DIR });
  const handle = app.getRequestHandler();
  await app.prepare();

  // Next installs a catch-all upgrade listener lazily from getRequestHandler.
  // In production Methyl owns the only WebSocket endpoint, so retain the
  // Methyl proxy listener and remove Next's competing route handler after it
  // is registered. Otherwise a browser WebSocket is closed before the Loro
  // handshake reaches the internal server.
  function handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const upstream = netConnect(INTERNAL_WS_PORT, "127.0.0.1", () => {
      const rawHeaders: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawHeaders.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n${rawHeaders.join("\r\n")}\r\n\r\n`;
      upstream.write(requestLine);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
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
      apiHandler(req, res);
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

  // Proxy WebSocket upgrades to the internal loro-websocket SimpleServer.
  server.on("upgrade", handleUpgrade);

  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`[methyl] listening on http://${HOST}:${PORT} (vault: ${VAULT_PATH})`);

  const shutdown = async (signal: string) => {
    console.log(`[methyl] received ${signal}, shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await syncServer.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[methyl] fatal error during startup:", err);
  process.exit(1);
});
