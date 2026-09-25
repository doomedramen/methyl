import { CacheFirst, Serwist, StaleWhileRevalidate } from "serwist";
import type { PrecacheEntry } from "serwist";
import type { SharePayload } from "@/lib/vault/share-payload";

/**
 * Cache Storage entry the OS share sheet's POST lands in, read once by
 * VaultApp on the `/?action=share` redirect below and then deleted. This
 * is the one deliberate use of Cache API for something other than static
 * app-shell assets: it holds a single transient payload (title/text/url,
 * or small text-file contents) for the seconds between share and pickup,
 * never vault content — vault data still only ever lives in OPFS (SPEC
 * §17). A distinct cache name keeps it out of the precache/runtime-cache
 * cleanup Serwist does on activate.
 */
const SHARE_CACHE = "methyl-share-pending";
const SHARE_KEY = "share-pending";

// Injected by `serwist build`:
declare global {
  interface ServiceWorkerGlobalScope {
    __SW_MANIFEST: (PrecacheEntry | string)[];
  }
}

export {};

declare const self: ServiceWorkerGlobalScope;

/**
 * Methyl service worker. Caches ONLY the app shell + runtime assets
 * (HTML/JS/CSS/WASM/icons). Vault data lives in OPFS and must never
 * be stored in the Cache API (SPEC §17).
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // A waiting worker no longer activates itself: an open tab may still be
  // relying on the chunks the old worker is serving, and skipWaiting here
  // would swap them out from under it mid-session (stale-chunk errors on
  // the next lazy import). Instead the page decides when it's safe — see
  // usePwa()/applyUpdate() in src/lib/browser/pwa.ts, which posts
  // SKIP_WAITING once the user accepts the "reload to update" prompt.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  cacheId: "methyl-app",
  // There's no more prerendered `out/index.html` to fall back to — `/` is
  // now a server-rendered (but static) Next page, precached by URL like any
  // other entry (see serwist.config.js's `precachePrerendered`). Every
  // route, including deep note URLs (`/<vault>/<path>`, served by the
  // dynamic `[...slug]` route), renders the same client-side shell that
  // resolves the open note from the URL in the browser (VaultApp.tsx), so
  // falling back to the cached `/` document works for any offline
  // navigation.
  precacheOptions: {
    navigateFallback: "/",
    navigateFallbackDenylist: [/^\/api\//, /^\/healthz$/],
  },
  runtimeCaching: [
    {
      matcher: /\.(?:wasm)(?:\?.*)?$/,
      handler: new CacheFirst({
        cacheName: "methyl-wasm",
      }),
    },
    {
      matcher: /\.(?:js|css|png|svg|ico|woff2?)(?:\?.*)?$/,
      handler: new StaleWhileRevalidate(),
    },
    // manifest.webmanifest's share_target posts here (browser-native "Share
    // to Methyl"). Reads the multipart body into a plain JSON payload,
    // stashes it (see SHARE_CACHE above), then redirects into the app the
    // same way every other capture entry point arrives: VaultApp.tsx picks
    // up `?action=share`, builds the note via share-payload.ts, and files
    // it in Inbox/.
    {
      method: "POST",
      matcher: ({ url }) => url.pathname === "/share",
      handler: async ({ request }) => {
        const payload = await formDataToSharePayload(await request.formData());
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(SHARE_KEY, new Response(JSON.stringify(payload)));
        return Response.redirect("/?action=share", 303);
      },
    },
  ],
  disableDevLogs: true,
});

/**
 * Only text-like shares are supported (see share-payload.ts's doc
 * comment) — the manifest's `share_target.params.files.accept` already
 * restricts the share sheet to Markdown/plain-text, but a misbehaving
 * sender could still post something else, so non-text files are dropped
 * rather than stashed as (useless, undecodable) binary JSON.
 */
async function formDataToSharePayload(form: FormData): Promise<SharePayload> {
  const files: { name: string; content: string }[] = [];
  for (const value of form.getAll("files")) {
    if (value instanceof File) {
      files.push({ name: value.name, content: await value.text() });
    }
  }
  const str = (key: string): string | undefined => {
    const v = form.get(key);
    return typeof v === "string" ? v : undefined;
  };
  return {
    title: str("title"),
    text: str("text"),
    url: str("url"),
    files: files.length > 0 ? files : undefined,
  };
}

serwist.addEventListeners();

// Runtime caches used to be named `adhd-*`; drop them once this worker
// takes over (vault data never lives in Cache Storage — SPEC §17).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("adhd-")).map((k) => caches.delete(k)))),
  );
});

// Lets the waiting worker activate on the page's schedule instead of ours
// (see the skipWaiting: false comment above).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});