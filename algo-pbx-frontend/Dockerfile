FROM node:20-alpine AS deps
WORKDIR /app
# Alpine 3.23 (node:20-alpine's current base) ships only OpenSSL 3.x, with
# no openssl1.1-compat package available at all — but Prisma 5.22's own
# platform auto-detection during `npm ci`'s postinstall still defaults to
# fetching an openssl-1.1.x-linked engine binary on this image, which then
# fails to load ("Error loading shared library libssl.so.1.1", "Could not
# parse schema engine response") the moment `prisma migrate deploy` runs
# in the runner stage. binaryTargets in prisma/schema.prisma fixes this
# for the CLIENT query engine (used by every DB call the app itself
# makes) but does NOT influence which schema-engine binary the `prisma`
# CLI package's own postinstall downloads — that needs this env var set
# BEFORE `npm ci`, which Prisma's fetch-engine reads to skip its faulty
# auto-detection.
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Non-root: the previous image ran the whole Next.js process as root with
# no offsetting reason to (no privileged port, no host device access) —
# unnecessary blast radius for any RCE in this process or a dependency.
# node:alpine ships a `node` user (uid 1000) out of the box.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Prisma's generated client + schema/migrations are needed at runtime: the
# client to talk to Postgres, the schema+migrations so `prisma migrate
# deploy` (run below at container start) can apply pending migrations —
# there was previously no migration step anywhere in this image or in
# docker-compose.yml, meaning a fresh deploy had no database schema at all
# and every route 500'd. `migrate deploy` (not `migrate dev`, which is
# interactive/destructive) is the correct non-interactive production
# command for this.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
RUN chown -R nextjs:nodejs /app
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=15s \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# PRISMA_SCHEMA_ENGINE_BINARY: even with the correct engine variant
# downloaded (PRISMA_CLI_BINARY_TARGETS above ensures
# schema-engine-linux-musl-openssl-3.0.x exists on disk), the CLI's OWN
# runtime pick of WHICH binary to exec re-runs the same faulty OpenSSL
# auto-detection and reaches for the openssl-1.1.x one anyway — this
# pins the exact file, sidestepping that detection entirely. Verified: a
# freshly-built image fails with "Could not parse schema engine
# response" / "Error loading shared library libssl.so.1.1" without this
# var and applies migrations cleanly with it.
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/prisma/node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x
# Same faulty auto-detection hits the QUERY engine Prisma Client loads at
# request time (every DB call the app makes) — pin that one too. Verified:
# GET /api/health 503'd with "Error loading shared library libssl.so.1.1"
# (needed by the openssl-1.1.x-tagged .so.node) without this, and returns
# 200 with it set.
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
# Not `npx prisma`: this stage never copies node_modules/.bin (only the
# selective .prisma/@prisma/prisma package dirs above), so npx has no bin
# entry to resolve and fails with a bare "prisma: not found" — invoking
# the CLI's own entry file directly with node sidesteps bin resolution
# entirely and needs nothing else copied.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"]

# Separate target for the CDR listener (docker-compose.yml's `cdr-listener`
# service). NOT part of the `runner` image above: that image is Next's
# "standalone" output, which only bundles what the web server itself needs
# and has no node_modules/scripts for a second process to run from. This
# stage instead reuses `deps`'s full node_modules (tsx, the listener's only
# real dependency here) plus the raw source, since tsx transpiles .ts on
# the fly — no separate build step needed for this process.
FROM node:20-alpine AS cdr-listener
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY src/lib ./src/lib
USER nextjs
CMD ["npx", "tsx", "scripts/ami-cdr-listener.ts"]
