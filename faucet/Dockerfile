# Aztec privacy-lab testnet faucet.
# Multi-stage: install deps in a builder, ship just node_modules + src in the
# final image. Runs as a non-root user with a read-only root FS; only /data
# is writable (mounted volume for the SQLite rate-limit DB and PXE state).

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 needs build tools; install them in this stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Headers for native libs (sqlite already built; only need runtime libs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /bin/bash faucet

COPY --from=builder --chown=faucet:faucet /app/node_modules ./node_modules
COPY --chown=faucet:faucet package.json tsconfig.json ./
COPY --chown=faucet:faucet src ./src
# The dashboard's published testnet-state.json is copied in at build time.
# Rebuild the image whenever the contracts are redeployed.
COPY --chown=faucet:faucet testnet-state.json ./testnet-state.json

USER faucet
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 8095

# tini reaps zombies + forwards signals cleanly to the node process.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "--experimental-strip-types", "src/index.ts"]
