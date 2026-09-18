# syntax=docker/dockerfile:1

# Full app deps (Next.js, React, editor/UI libs, build tooling) — used to
# produce the Next build (.next/) and the bundled server (dist/), never
# copied into the runtime image wholesale.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# build tools in case a native dep (e.g. better-sqlite3) has no prebuilt
# binary for this arch/libc — only needed here, never in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Cache mount keeps the npm download cache between CI runs (buildx gha
# cache), so a rebuild re-links rather than re-downloads the tree.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build && npm run build:server

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

# The in-process server needs the app's full runtime deps (Next, React), the
# Next build output, public assets, and the bundled server entrypoint.
COPY --from=build --chown=methyl:methyl /app/node_modules ./node_modules
COPY --from=build --chown=methyl:methyl /app/.next ./.next
COPY --from=build --chown=methyl:methyl /app/public ./public
COPY --from=build --chown=methyl:methyl /app/dist ./dist

USER methyl
VOLUME ["/vault"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.METHYL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]