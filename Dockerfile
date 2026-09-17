# syntax=docker/dockerfile:1

# Full app deps (Next.js, React, editor/UI libs, build tooling) — only used
# to produce the Next standalone server (.next/standalone) and the sync
# server bundle (dist/), never copied into the runtime image wholesale.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# build tools in case a native dep (e.g. better-sqlite3) has no prebuilt
# binary for this arch/libc — only needed here, never in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build && npm run build:server

# Minimal runtime node_modules: only the packages esbuild leaves external in
# build:server (native/wasm modules that can't be bundled), pinned to the
# exact versions in package-lock.json, installed on their own so the
# runtime image doesn't carry the rest of the app's dependency tree.
# Prebuilt binaries cover linux/amd64 and linux/arm64 glibc, so no compiler
# toolchain is needed here.
FROM node:24-bookworm-slim AS server-deps
WORKDIR /server
# Same fallback as the "deps" stage; this stage's contents besides
# node_modules are never copied into the runtime image, so these tools
# don't affect the final image size.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json scripts/generate-server-manifest.mjs ./
RUN node generate-server-manifest.mjs package.json \
    && rm generate-server-manifest.mjs package-lock.json \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /root/.npm

FROM node:24-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Methyl" \
      org.opencontainers.image.description="Self-hostable, offline-first Markdown vault" \
      org.opencontainers.image.source="https://github.com/doomedramen/methyl" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    METHYL_PORT=8080 \
    METHYL_HOST=0.0.0.0 \
    METHYL_VAULT_PATH=/vault

RUN groupadd --system --gid 1001 methyl \
    && useradd --system --uid 1001 --gid methyl --home-dir /app --shell /usr/sbin/nologin methyl \
    && mkdir -p /vault && chown -R methyl:methyl /vault /app

# `.next/standalone` is Next's traced, self-contained server (own
# node_modules, server.js) — see next.config.ts's `output: "standalone"`.
# It doesn't include `.next/static` or `public/` on its own (Next's own
# convention; see node_modules/next/dist/docs); `npm run build` layers them
# in at the paths server.js expects (scripts/copy-standalone-assets.mjs), so
# a single copy of the already-complete standalone dir is enough here.
COPY --from=build --chown=methyl:methyl /app/.next/standalone ./.next/standalone
# Runtime deps for src/server/main.ts itself (better-sqlite3, loro-*,
# chokidar — see scripts/generate-server-manifest.mjs); separate from and
# smaller than .next/standalone's own node_modules (Next, React).
COPY --from=server-deps --chown=methyl:methyl /server/node_modules ./node_modules
COPY --from=build --chown=methyl:methyl /app/dist ./dist

USER methyl
VOLUME ["/vault"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.METHYL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
