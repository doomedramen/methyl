import { createReadStream, existsSync, statSync } from "fs";
import { join, normalize, sep, extname } from "path";
import type { IncomingMessage, ServerResponse } from "http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the static Next.js export (`out/`) from a single origin, including
 * SPA fallback to index.html for client-side routes. `sw.js` (and its
 * sourcemap) are served with no-cache headers so browsers always fetch the
 * latest service worker, per standard PWA update guidance.
 */
export function createStaticHandler(outDir: string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    // Prevent path traversal outside outDir.
    pathname = normalize(pathname).replace(/^(\.\.[/\\])+/, "");

    let filePath = join(outDir, pathname);
    if (!filePath.startsWith(outDir + sep) && filePath !== outDir) {
      res.writeHead(400).end("bad request");
      return true;
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, "index.html");
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback: anything that isn't a real file is an app route —
      // including note routes like /local/Projects/note.md, which carry a
      // file extension but are client-side routes, not files in `out/`.
      // Build assets are excluded so a missing chunk 404s honestly instead
      // of returning HTML.
      if (pathname.startsWith("/_next/")) return false;
      filePath = join(outDir, "index.html");
    }

    if (!existsSync(filePath)) return false;

    const ext = extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": contentType };

    const base = filePath.slice(outDir.length + 1);
    if (base === "sw.js" || base === "sw.js.map") {
      headers["cache-control"] = "no-cache, no-store, must-revalidate";
    } else if (ext === ".html") {
      headers["cache-control"] = "no-cache";
    } else {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
    } else {
      createReadStream(filePath).pipe(res);
    }
    return true;
  };
}
