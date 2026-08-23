FROM node:20-alpine AS deps
WORKDIR /app
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
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]

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
