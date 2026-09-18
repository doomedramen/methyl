import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // No self-hosted image optimization (no sharp) — avoids the extra
    // CPU/deps for a single-user, self-hosted app.
    unoptimized: true,
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
