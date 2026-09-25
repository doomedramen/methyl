# syntax=docker/dockerfile:1

# Build: the full dependency tree and toolchain, never shipped.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing here needs an install script. better-sqlite3
# loads the prebuilt binary it ships (npm would otherwise compile it anyway,
# needing Python and a compiler), and the rest are dev tools (esbuild finds
# its platform binary without its postinstall; lefthook would install git
# hooks). The cache mount keeps npm's download cache between CI runs
# (buildx gha cache), so a rebuild re-links rather than re-downloads.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
# The version the app and server report: the release tag, or 0.0.0-<sha>
# (the workflow passes it; .git isn't in the build context).
ARG APP_VERSION=""
ENV NEXT_PUBLIC_APP_VERSION=${APP_VERSION}
COPY . .
RUN npm run build && npm run build:server

# The runtime tree: Next's standalone output (the server files and only the
# node_modules files they use), its static assets, the server bundle, and
# the packages the bundle leaves external. Plus an empty vault folder, since
# the runtime image has no shell to create one.
RUN mkdir -p /out/app/.next /out/app/dist /out/vault \
    && cp -r .next/standalone/. /out/app/ \
    && cp -r .next/static /out/app/.next/static \
    && cp -r public /out/app/public \
    && cp dist/server.cjs /out/app/dist/ \
    && node scripts/copy-server-externals.mjs node_modules /out/app/node_modules

# Runtime: distroless Node, no shell or package manager.
FROM gcr.io/distroless/nodejs24-debian12 AS runtime
ARG APP_VERSION=""
LABEL org.opencontainers.image.title="Methyl" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.description="Self-hostable, offline-first Markdown vault" \
      org.opencontainers.image.source="https://github.com/doomedramen/methyl" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    METHYL_PORT=8080 \
    METHYL_HOST=0.0.0.0 \
    METHYL_VAULT_PATH=/vault

# uid 1001 is the user earlier images ran as, so existing vault volumes stay
# writable.
COPY --from=build --chown=1001:1001 /out/app /app
COPY --from=build --chown=1001:1001 /out/vault /vault

USER 1001:1001
VOLUME ["/vault"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.METHYL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The image's entrypoint is node; `docker compose exec methyl /nodejs/bin/node
# dist/server.cjs backup …` runs the backup command.
CMD ["dist/server.cjs"]
