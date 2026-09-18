import { CacheFirst, Serwist, StaleWhileRevalidate } from "serwist";
import type { PrecacheEntry } from "serwist";

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
  cacheId: "adhd-app",
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
        cacheName: "adhd-wasm",
      }),
    },
    {
      matcher: /\.(?:js|css|png|svg|ico|woff2?)(?:\?.*)?$/,
      handler: new StaleWhileRevalidate(),
    },
  ],
  disableDevLogs: true,
});

serwist.addEventListeners();

// Lets the waiting worker activate on the page's schedule instead of ours
// (see the skipWaiting: false comment above).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});