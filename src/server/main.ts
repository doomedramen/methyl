import { spawn, type ChildProcess } from "child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { connect as netConnect } from "net";
import { join } from "path";
import { createSyncServer, createHttpApi } from "@/lib/server/sync-server";

const PORT = Number(process.env.METHYL_PORT ?? 8080);
const HOST = process.env.METHYL_HOST ?? "0.0.0.0";
const VAULT_PATH = process.env.METHYL_VAULT_PATH ?? "/vault";
const WATCH = process.env.METHYL_WATCH !== "false";
const AUTH_TOKEN = process.env.METHYL_AUTH_TOKEN;
// `.next/standalone` produced by `next build` with `output: "standalone"`
// (see next.config.ts) — a self-contained Next server plus its traced
// runtime deps. Defaults to the layout the Dockerfile copies into the
// image; overridable for running against a differently-located build.
const NEXT_STANDALONE_DIR = process.env.METHYL_NEXT_STANDALONE_DIR ?? join(__dirname, "..", ".next", "standalone");
// CORS for /api + /healthz: only needed when the browser app is served from
// a different origin than this server (e.g. the static app hosted
// separately from the sync server). Same-origin requests need no CORS
// headers at all, so the default is to send none. Set a comma-separated
// allow-list to opt in.
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
 * The Next.js app (`.next/standalone/server.js`) is handled the same way:
 * Next's `output: "standalone"` produces its own self-contained server that
 * binds its own port — there's no in-process "handler" API compatible with
 * standalone tracing (a custom `next(...)`-based server and `output:
 * "standalone"` are mutually exclusive; standalone doesn't trace custom
 * server files). So it's run as a child process on a loopback-only port,
 * and this process reverse-proxies ordinary HTTP requests to it. This
 * keeps the small, traced standalone runtime while still presenting a
 * single public port for the app, /api/*, /healthz and the WS upgrade.
 */
const INTERNAL_WS_PORT = Number(process.env.METHYL_INTERNAL_WS_PORT ?? PORT + 10000);
const INTERNAL_HTTP_PORT = Number(process.env.METHYL_INTERNAL_HTTP_PORT ?? PORT + 10001);
const INTERNAL_NEXT_PORT = Number(process.env.METHYL_INTERNAL_NEXT_PORT ?? PORT + 10002);

function startNextServer(): ChildProcess {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: NEXT_STANDALONE_DIR,
    env: {
      ...process.env,
      PORT: String(INTERNAL_NEXT_PORT),
      HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    console.error(`[methyl] Next server exited (code=${code} signal=${signal}), shutting down`);
    process.exit(1);
  });
  return child;
}

/** Poll the internal Next server until it accepts connections. */
async function waitForNextServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = netConnect(INTERNAL_NEXT_PORT, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for the Next.js server to start");
}

// `/_next/*` should only ever serve build assets (JS/CSS/fonts/etc, or a
// genuine 404) — never the HTML app shell. If `.next/static` isn't where
// the internal Next server expects it (see scripts/copy-standalone-assets.mjs
// and the Dockerfile), Next's own router falls through unmatched `/_next/*`
// requests to the catch-all app route and happily answers 200 with the
// shell's HTML, which is worse than a 404: every chunk "loads" but the app
// renders unstyled and never boots. Treat that as a 404 instead of relaying
// it, so a missing-assets misconfiguration fails loudly.
function isNextAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/");
}

/** Reverse-proxy a request to the internal Next.js server. */
function proxyToNext(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: INTERNAL_NEXT_PORT,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"] ?? "";
      if (isNextAssetPath(pathname) && contentType.includes("text/html")) {
        upstreamRes.resume(); // drain so the socket can be reused
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    console.error("[methyl] proxy to Next server failed:", err);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway");
    else res.destroy();
  });
  req.pipe(upstream);
}

async function main() {
  const nextChild = startNextServer();
  await waitForNextServer();

  const syncServer = createSyncServer({
    port: INTERNAL_WS_PORT,
    httpPort: INTERNAL_HTTP_PORT,
    host: "127.0.0.1",
    vaultPath: VAULT_PATH,
    authToken: AUTH_TOKEN!,
    watch: WATCH,
  });

  await syncServer.start();

  const assetDir = `${VAULT_PATH}/.adhd/server/assets`;
  const apiHandler = createHttpApi({ store: syncServer.store, authToken: AUTH_TOKEN!, assetDir });

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

    proxyToNext(req, res);
  });

  // Proxy WebSocket upgrades to the internal loro-websocket SimpleServer.
  server.on("upgrade", (req: IncomingMessage, clientSocket, head) => {
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
  });

  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`[methyl] listening on http://${HOST}:${PORT} (vault: ${VAULT_PATH})`);

  const shutdown = async (signal: string) => {
    console.log(`[methyl] received ${signal}, shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await syncServer.stop();
    nextChild.removeAllListeners("exit");
    nextChild.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[methyl] fatal error during startup:", err);
  process.exit(1);
});
