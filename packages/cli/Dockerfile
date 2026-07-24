# syntax=docker/dockerfile:1
# Pin bun to the lockfile / CI version (1.3.11) for reproducible installs.
FROM oven/bun:1.3.11-slim AS base

WORKDIR /app

# Root manifests + every workspace package.json. `--parents` keeps the
# packages/<name>/ layout and globs all members, so bun's frozen install always
# sees the full workspace and a new package needs no Dockerfile edit.
COPY package.json bun.lock turbo.json ./
COPY --parents packages/*/package.json ./

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Copy built source
COPY packages/sdk/dist packages/sdk/dist
COPY packages/cli/dist packages/cli/dist

ENTRYPOINT ["bun", "run", "packages/cli/dist/index.js"]
