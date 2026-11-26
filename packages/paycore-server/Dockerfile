# syntax=docker/dockerfile:1
# The PayCore server: many hosted PayCore stores in one process (their nodes,
# leases and ledgers in Postgres), the admin API and the operator CLI.
# Build from the repository root:
#   docker build -f packages/paycore-server/Dockerfile -t paycore-server .
# Run next to Postgres (settings and deploy notes: packages/paycore-server/DEPLOY.md):
#   docker run -d -e DATABASE_URL=... -e PAYCORE_MASTER_KEY_FILE=/run/secrets/paycore_master_key \
#     -e PAYCORE_PUBLIC_BASE=https://paycore.example.com -e PAYCORE_TRUST_PROXY=1 \
#     -e PAYCORE_SOLANA_RPC_MAINNET=... -p 8790:8790 paycore-server
# Operator commands run in the same image:
#   docker run --rm -e DATABASE_URL=... -e PAYCORE_MASTER_KEY_FILE=... \
#     -e PAYCORE_PUBLIC_BASE=... paycore-server store list
ARG BUN_IMAGE=oven/bun:1.3.11-slim

# Build stage: compile from source. merchant-node is bundled into the
# server's dist through the `@merchant-node/*` path alias, so it needs no dist.
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build --filter=@elisym/paycore-server...

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

# tini as PID 1: `docker stop` reaches the server's SIGTERM handler, which
# stops every store node and gives its leases up before exiting.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock turbo.json ./
COPY --parents packages/*/package.json ./

# pay-core bundles @elisym/config-client (noExternal), so it is not installed here.
RUN bun install --frozen-lockfile --production \
  --filter @elisym/paycore-server --filter @elisym/commerce --filter @elisym/pay-core

COPY --from=build /app/packages/pay-core/dist packages/pay-core/dist
COPY --from=build /app/packages/commerce/dist packages/commerce/dist
COPY --from=build /app/packages/paycore-server/dist packages/paycore-server/dist

ENV PORT=8790
EXPOSE 8790
USER bun

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "packages/paycore-server/dist/main.js"]
