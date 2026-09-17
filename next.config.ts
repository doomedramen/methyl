import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    // No self-hosted image optimization (no sharp in the runtime image) —
    // avoids the extra CPU/deps for a single-user, self-hosted app.
    unoptimized: true,
  },
  // images.unoptimized means sharp is never loaded at runtime; keep it (and
  // its native @img/* deps) out of `.next/standalone`, which would
  // otherwise trace and copy it into every build regardless.
  outputFileTracingExcludes: {
    "*": ["node_modules/sharp/**", "node_modules/@img/**"],
  },
  // Browsers must always re-check sw.js so an update is picked up promptly
  // (standard PWA guidance) — Next serves public/ files with no special
  // cache-control by default, so this is set explicitly.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
