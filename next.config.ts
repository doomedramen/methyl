import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

// The release tag, or 0.0.0-<sha> (scripts/app-version.mjs), inlined into
// the client so the UI and diagnostics can show it.
const appVersion = execFileSync(process.execPath, ["scripts/app-version.mjs"], { encoding: "utf8" }).trim();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
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
