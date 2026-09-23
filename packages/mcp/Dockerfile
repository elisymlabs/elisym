# syntax=docker/dockerfile:1
# Pin bun to the lockfile / CI version (1.3.11) for reproducible installs.
ARG BUN_IMAGE=oven/bun:1.3.11-slim

# Build stage: compile from source, so the image never depends on a dist/ left
# over on the host, and a new runtime package needs no hand-added COPY here to
# be BUILT (only to be shipped, below).
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build --filter=@elisym/mcp...

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

# Root manifests + every workspace package.json. `--parents` keeps the
# packages/<name>/ layout and globs all members, so bun's frozen install always
# sees the full workspace and a new package needs no Dockerfile edit.
COPY package.json bun.lock turbo.json ./
COPY --parents packages/*/package.json ./

# Production dependencies of the packages that run, and nothing else: the
# workspace also holds the web app and the docs site, whose dependencies have
# no business in this image (about 1 GB and 2,700 packages unfiltered).
RUN bun install --frozen-lockfile --production \
  --filter @elisym/mcp --filter @elisym/sdk --filter @elisym/pay-core

# The built output of every package that runs at runtime
COPY --from=build /app/packages/pay-core/dist packages/pay-core/dist
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist

# Run unprivileged, as the image's `bun` user (uid 1000). HOME stays /root so
# the documented mount `-v ~/.elisym:/root/.elisym` still lands in the agent
# store; /root is handed to that user, and left traversable (0755) so a Linux
# host whose uid is not 1000 can pass `--user "$(id -u):$(id -g)"` and still
# reach the mount it owns (see the README). /app (the working directory, where
# a tool may write a file it was asked to save) is the user's too, as it was
# root's before.
RUN chown bun:bun /root /app && chmod 0755 /root
ENV HOME=/root
USER bun

# `bun <file>` rather than `bun run <file>`: no script-runner shim between the
# container's signals and the process.
ENTRYPOINT ["bun", "packages/mcp/dist/index.js"]
