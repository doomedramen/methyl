/** @type {import('@serwist/build').InjectManifestOptions} */
export default {
  globDirectory: "./out",
  globPatterns: [
    "**/*.{html,js,css,svg,png,ico,wasm,woff2}",
  ],
  globIgnores: ["sw.js"],
  swSrc: "./src/app/sw.ts",
  swDest: "./out/sw.js",
  maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
};