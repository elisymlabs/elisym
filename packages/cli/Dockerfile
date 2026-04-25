FROM oven/bun:1-slim AS base

WORKDIR /app

# Install root workspace files
COPY package.json bun.lock turbo.json ./
COPY packages/config-client/package.json packages/config-client/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/app/package.json packages/app/package.json

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Copy built source
COPY packages/sdk/dist packages/sdk/dist
COPY packages/cli/dist packages/cli/dist

ENTRYPOINT ["bun", "run", "packages/cli/dist/index.js"]
