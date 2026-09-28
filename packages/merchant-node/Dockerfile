# syntax=docker/dockerfile:1
# The elisym merchant node. Build from the repository root:
#   docker build -f packages/merchant-node/Dockerfile -t elisym-merchant .
# Run with the home on a volume (it holds the store's secret keys and ledger):
#   docker run -v elisym-merchant:/data elisym-merchant init
#   docker run -d --restart unless-stopped -v elisym-merchant:/data elisym-merchant run
# Pin bun to the lockfile / CI version (1.3.11) for reproducible installs.
ARG BUN_IMAGE=oven/bun:1.3.11-slim

# Build stage: compile from source, so the image never depends on a dist/ left
# over on the host.
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build --filter=@elisym/merchant-node...

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

# tini as PID 1: `docker stop` reaches the node's SIGTERM handler, which
# releases the home's lock before exiting.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# Root manifests + every workspace package.json, so bun's frozen install sees
# the whole workspace.
COPY package.json bun.lock turbo.json ./
COPY --parents packages/*/package.json ./

# Production dependencies of the packages that run, and nothing else.
RUN bun install --frozen-lockfile --production \
  --filter @elisym/merchant-node --filter @elisym/commerce --filter @elisym/pay-core

COPY --from=build /app/packages/pay-core/dist packages/pay-core/dist
COPY --from=build /app/packages/commerce/dist packages/commerce/dist
COPY --from=build /app/packages/merchant-node/dist packages/merchant-node/dist

# The home lives on a volume; the image's `bun` user (uid 1000) owns it.
RUN mkdir -m 0700 /data && chown bun:bun /data
VOLUME /data
ENV ELISYM_MERCHANT_HOME=/data
USER bun

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "packages/merchant-node/dist/cli.js"]
CMD ["run"]
