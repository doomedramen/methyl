import { generateSW } from "@serwist/build";

const root = new URL("../out/", import.meta.url).pathname;

await generateSW({
  globDirectory: root,
  globPatterns: [
    "**/*.{html,js,css,svg,png,ico,wasm,woff,woff2,ttf,json}",
  ],
  globIgnores: ["sw.js", "sw.json", "manifest.webmanifest"],
  swDest: `${root}sw.js`,
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [/\/_next\/.*/, /\.(?:png|jpg|jpeg|gif|svg|webp)$/],
  runtimeCaching: [
    {
      urlPattern: /\/_next\/.*/,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "adhd-app-precache-runtime",
      },
    },
  ],
  skipWaiting: true,
  clientsClaim: true,
  maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
  disableDevLogs: true,
  cleanupOutdatedCaches: true,
});

console.log("service worker written to out/sw.js");