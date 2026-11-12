# syntax=docker/dockerfile:1
# The Askr server (9): gateway, agent workers, admin API and widget.js in one
# service. Build from the repository root:
#   docker build -f packages/askr-server/Dockerfile -t askr-server .
# Run next to Postgres and the relay:
#   docker run -d -e DATABASE_URL=... -e ASKR_MASTER_KEY_FILE=/run/secrets/askr_master_key \
#     -e ASKR_GATEWAY_SECRET=... -e ANTHROPIC_API_KEY=... -e ASKR_MODEL=... \
#     -e ASKR_PRICE_INPUT=... -e ASKR_PRICE_CACHED_INPUT=... -e ASKR_PRICE_CACHE_WRITE=... \
#     -e ASKR_PRICE_OUTPUT=... -e ASKR_TRUST_PROXY=1 -p 8787:8787 askr-server
# Operator commands run in the same image:
#   docker run --rm -e DATABASE_URL=... -e ASKR_MASTER_KEY_FILE=... askr-server store list
ARG BUN_IMAGE=oven/bun:1.3.11-slim

# Build stage: compile from source (the widget is a devDependency of the
# server, so turbo builds it first).
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build --filter=@elisym/askr-server...

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

# tini as PID 1: `docker stop` reaches the server's SIGTERM handler, which
# gives its leases up before exiting.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock turbo.json ./
COPY --parents packages/*/package.json ./

RUN bun install --frozen-lockfile --production \
  --filter @elisym/askr-server --filter @elisym/askr-agent --filter @elisym/askr \
  --filter @elisym/commerce --filter @elisym/pay-core

COPY --from=build /app/packages/pay-core/dist packages/pay-core/dist
COPY --from=build /app/packages/commerce/dist packages/commerce/dist
COPY --from=build /app/packages/askr/dist packages/askr/dist
COPY --from=build /app/packages/askr-agent/dist packages/askr-agent/dist
COPY --from=build /app/packages/askr-server/dist packages/askr-server/dist
COPY --from=build /app/packages/askr-widget/dist/widget.js packages/askr-server/widget/widget.js

ENV ASKR_WIDGET_FILE=/app/packages/askr-server/widget/widget.js
ENV PORT=8787
EXPOSE 8787
USER bun

ENTRYPOINT ["/usr/bin/tini", "--", "bun", "packages/askr-server/dist/main.js"]
