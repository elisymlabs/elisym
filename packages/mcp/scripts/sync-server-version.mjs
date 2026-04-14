#!/usr/bin/env node
/**
 * Sync server.json version with package.json.
 *
 * The MCP Registry validates that server.json's npm package version matches a
 * version actually published on npm with the matching `mcpName` field. If
 * server.json drifts behind package.json (e.g. after a version bump), the
 * registry publish fails with a 400 because it looks up the stale version.
 *
 * Run before `mcp-publisher publish`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const pkgPath = join(pkgRoot, 'package.json');
const serverPath = join(pkgRoot, 'server.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const server = JSON.parse(readFileSync(serverPath, 'utf8'));

const targetVersion = pkg.version;
const before = { top: server.version, pkg0: server.packages?.[0]?.version };

server.version = targetVersion;
if (server.packages?.[0]) {
  server.packages[0].version = targetVersion;
}

writeFileSync(serverPath, JSON.stringify(server, null, 2) + '\n');

console.log(`[sync-server-version] server.json updated to ${targetVersion}`);
console.log(`  top-level version:     ${before.top} -> ${targetVersion}`);
console.log(`  packages[0].version:   ${before.pkg0} -> ${targetVersion}`);
