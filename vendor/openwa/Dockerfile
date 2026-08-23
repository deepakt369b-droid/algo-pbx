# Builds OpenWA (https://github.com/rmyndharis/OpenWA, MIT) from a pinned
# upstream commit — see this directory's README.md for why we clone-at-
# build-time instead of vendoring the full source tree into git.
#
# IMPORTANT: replace this default with a real commit SHA before the first
# build (`git ls-remote https://github.com/rmyndharis/OpenWA main`).
# Left as `main` here only because no build has been run against this
# Dockerfile yet in this environment (no Docker/network access from this
# session) — pin it before deploying, not after.
ARG OPENWA_COMMIT=main

FROM node:22-slim AS builder
ARG OPENWA_COMMIT
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/rmyndharis/OpenWA.git . \
    && git checkout "${OPENWA_COMMIT}"
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /src/dist ./dist
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/package.json ./package.json
EXPOSE 2785
HEALTHCHECK --interval=15s --timeout=5s --retries=6 --start-period=20s \
    CMD node -e "fetch('http://localhost:2785/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
