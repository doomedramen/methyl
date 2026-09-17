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
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  cacheId: "adhd-app",
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