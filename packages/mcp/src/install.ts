/**
 * Auto-install elisym MCP server into Claude Desktop, Cursor, Windsurf configs.
 */
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { validateAgentName } from '@elisym/sdk';
import { writeFileAtomic } from './atomic-write.js';
import { PACKAGE_VERSION } from './utils.js';

/**
 * Single source of truth for the npx args we write into client configs. Shared
 * by `runInstall` (fresh entry) and `runUpdate` (refresh of existing entry) so
 * the version pin format cannot drift between the two paths.
 */
function elisymPackageArgs(): string[] {
  return ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`];
}

interface McpClient {
  name: string;
  configPath: () => string | null;
}

/**
 * Reject unknown --client values up-front, before touching any config. Without
 * this a typo (e.g. `--client claude_code`) silently matches no client and we
 * print a misleading "no installs found" — the user thinks the operation
 * succeeded. Centralized so install/update/uninstall share the same allow-list.
 */
function validateClientName(name: string | undefined): void {
  if (name === undefined) {
    return;
  }
  if (!CLIENTS.some((c) => c.name === name)) {
    throw new Error(
      `Unknown client "${name}". Known clients: ${CLIENTS.map((c) => c.name).join(', ')}`,
    );
  }
}

/**
 * Recheck-then-write guard against read-modify-write races on third-party
 * config files. The motivating case is `~/.claude.json`, which Claude Code
 * itself rewrites whenever the user navigates between projects — if we read,
 * mutate, and write while Claude Code is running, the rename(2) at the end of
 * `writeJsonAtomic` silently clobbers whatever Claude Code just wrote.
 *
 * The caller passes the exact bytes they originally read; we re-read just
 * before the write and abort if anything has changed. This does NOT prevent
 * the race (a real fix needs `proper-lockfile` or `flock`), but it turns
 * silent data loss into a visible "Skipped" diagnostic the user can act on
 * by closing the client and re-running.
 *
 * Exported for unit testing — the comparison logic is the whole point.
 */
export async function safeRewriteJson(
  path: string,
  expectedRaw: string,
  newConfig: unknown,
): Promise<void> {
  let recheck: string;
  try {
    recheck = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `${path} disappeared between read and write: ${(err as Error).message}. ` +
        `Re-run after the file is restored.`,
    );
  }
  if (recheck !== expectedRaw) {
    throw new Error(
      `${path} was modified by another process during update. ` +
        `Close the MCP client and re-run.`,
    );
  }
  await writeJsonAtomic(path, newConfig);
}

const CLIENTS: McpClient[] = [
  {
    name: 'claude-desktop',
    configPath() {
      const home = homedir();
      switch (platform()) {
        case 'darwin':
          return join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
        case 'win32':
          return join(process.env.APPDATA ?? home, 'Claude/claude_desktop_config.json');
        default:
          // Claude Desktop does not ship on Linux. Return null so `list` surfaces
          // the right message and `install` skips the path entirely.
          return null;
      }
    },
  },
  {
    name: 'claude-code',
    // Claude Code CLI keeps user-scope MCP servers under `mcpServers` at the top
    // level of `~/.claude.json`. Project-scope (`.mcp.json` in cwd) and local-scope
    // (`projects.<path>.mcpServers` inside the same file) are deliberately not
    // touched here - this installer only writes user scope so the server is
    // available across all projects.
    configPath: () => join(homedir(), '.claude.json'),
  },
  {
    name: 'cursor',
    configPath: () => join(homedir(), '.cursor/mcp.json'),
  },
  {
    name: 'windsurf',
    configPath() {
      const home = homedir();
      if (platform() === 'darwin') {
        return join(home, 'Library/Application Support/Windsurf/mcp.json');
      }
      return join(home, '.windsurf/mcp.json');
    },
  },
];

function buildServerEntry(agentName?: string, env?: Record<string, string>): Record<string, any> {
  // use ~MAJOR.MINOR.PATCH so patches update automatically but minor versions
  // (which may break the schema) need an explicit `elisym-mcp install` re-run. The
  // version string is shared with `server.ts` and `index.ts` via `PACKAGE_VERSION` so
  // the install pin cannot drift from what the server reports.
  const entry: Record<string, any> = {
    command: 'npx',
    args: elisymPackageArgs(),
  };

  const mergedEnv: Record<string, string> = { ...env };
  if (agentName) {
    mergedEnv.ELISYM_AGENT = agentName;
  }

  if (Object.keys(mergedEnv).length > 0) {
    entry.env = mergedEnv;
  }

  return entry;
}

export async function runInstall(options: {
  client?: string;
  agent?: string;
  env?: Record<string, string>;
}): Promise<void> {
  validateClientName(options.client);
  if (options.agent) {
    validateAgentName(options.agent);
  }
  const entry = buildServerEntry(options.agent, options.env);
  let installed = 0;

  for (const client of CLIENTS) {
    if (options.client && client.name !== options.client) {
      continue;
    }

    const path = client.configPath();
    if (!path) {
      continue;
    }

    try {
      const success = await installToConfig(path, entry);
      if (success) {
        console.log(`Installed to ${client.name}: ${path}`);
        installed++;
      } else {
        console.log(`Already installed in ${client.name}`);
      }
    } catch (e: any) {
      console.log(`Skipped ${client.name}: ${e.message}`);
    }
  }

  if (installed === 0 && !options.client) {
    console.log('No MCP clients found to install into.');
  }
}

export async function runUpdate(options: { client?: string; agent?: string }): Promise<void> {
  validateClientName(options.client);
  if (options.agent) {
    validateAgentName(options.agent);
  }

  let updated = 0;

  for (const client of CLIENTS) {
    if (options.client && client.name !== options.client) {
      continue;
    }

    const path = client.configPath();
    if (!path) {
      continue;
    }

    // Distinguish ENOENT (client not installed - silent skip) from other read
    // errors (EACCES, EISDIR - surface to user) and from JSON parse failures
    // (likely a hand-edited config - warn and skip without modifying the file).
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.log(`Skipped ${client.name}: ${(err as Error).message}`);
      }
      continue;
    }

    let config: any;
    try {
      config = JSON.parse(raw);
    } catch {
      console.log(`Warning: ${path} is not valid JSON. Skipping update for ${client.name}.`);
      continue;
    }

    const existing = config.mcpServers?.elisym;
    // Guard against malformed configs: `mcpServers.elisym` could be a primitive
    // (string/number) if the file was hand-edited. We must not spread a non-object
    // into env nor read `.env` off it. Arrays are technically `object`, but they'd
    // produce a nonsense env shape — exclude them too.
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      continue;
    }

    // Preserve existing agent + env so an `update` doesn't silently strip the
    // agent binding. We mutate `newEnv` in place rather than rebuild via
    // `buildServerEntry` so that existing key ordering is preserved — that
    // produces clean diffs in user dotfiles instead of reshuffling env keys.
    const rawEnv = (existing as { env?: unknown }).env;
    const newEnv: Record<string, string> =
      rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
        ? { ...(rawEnv as Record<string, string>) }
        : {};

    // If the file already had an agent binding, re-validate it. A user may have
    // hand-edited the config; we refuse to "freshen" an invalid name into the new
    // entry — leave the file alone and let them fix it explicitly with --agent.
    const existingAgentRaw =
      typeof newEnv.ELISYM_AGENT === 'string' ? newEnv.ELISYM_AGENT : undefined;
    if (existingAgentRaw !== undefined && options.agent === undefined) {
      try {
        validateAgentName(existingAgentRaw);
      } catch (err) {
        console.log(
          `Skipped ${client.name}: existing ELISYM_AGENT in ${path} is invalid (${(err as Error).message}). ` +
            `Re-run with --agent <name> to overwrite.`,
        );
        continue;
      }
    }

    if (options.agent !== undefined) {
      // Overwrite at original key position if it was already there.
      newEnv.ELISYM_AGENT = options.agent;
    }

    // Mutate the existing entry in place rather than rebuild from scratch. The
    // user may have added custom fields (`cwd`, a fully-qualified `command`
    // path, extra args before the package spec) and an `update` should refresh
    // the version pin without dropping their customizations. We only touch the
    // package-spec slot inside `args` and the `env` block; everything else is
    // left intact.
    const entry = existing as Record<string, any>;
    const newArgs = elisymPackageArgs();
    if (Array.isArray(entry.args)) {
      // Find the existing `@elisym/mcp@...` token and replace it in place so
      // any user-added flags around it survive. If for some reason it's not
      // there (hand-edited entry), fall back to overwriting `args` wholesale —
      // we still need to land the new pin.
      const idx = entry.args.findIndex(
        (a: unknown) => typeof a === 'string' && a.startsWith('@elisym/mcp@'),
      );
      if (idx >= 0) {
        entry.args[idx] = newArgs[1]!;
      } else {
        entry.args = newArgs;
      }
    } else {
      entry.args = newArgs;
    }
    if (Object.keys(newEnv).length > 0) {
      entry.env = newEnv;
    } else {
      delete entry.env;
    }

    try {
      await safeRewriteJson(path, raw, config);
    } catch (err) {
      console.log(`Skipped ${client.name}: ${(err as Error).message}`);
      continue;
    }
    console.log(`Updated ${client.name}: ${path} -> @elisym/mcp@~${PACKAGE_VERSION}`);
    updated++;
  }

  if (updated === 0) {
    console.log('No existing elisym MCP installs found to update.');
  }
}

export async function runUninstall(options: { client?: string }): Promise<void> {
  validateClientName(options.client);

  for (const client of CLIENTS) {
    if (options.client && client.name !== options.client) {
      continue;
    }

    const path = client.configPath();
    if (!path) {
      continue;
    }

    // Split read / parse / write so the RMW guard can surface its own error
    // distinctly from "file doesn't exist" or "not valid JSON" — both of which
    // are normal "nothing to uninstall" outcomes and should stay silent.
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      continue;
    }

    let config: any;
    try {
      config = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!config.mcpServers?.elisym) {
      continue;
    }

    delete config.mcpServers.elisym;
    try {
      await safeRewriteJson(path, raw, config);
      console.log(`Removed from ${client.name}: ${path}`);
    } catch (err) {
      console.log(`Skipped ${client.name}: ${(err as Error).message}`);
    }
  }
}

export async function runList(): Promise<void> {
  for (const client of CLIENTS) {
    const path = client.configPath();
    if (!path) {
      console.log(`${client.name}: not supported on this platform`);
      continue;
    }

    try {
      const raw = await readFile(path, 'utf-8');
      const config = JSON.parse(raw);
      const installed = !!config.mcpServers?.elisym;
      console.log(`${client.name}: ${installed ? 'installed' : 'available'} (${path})`);
    } catch {
      console.log(`${client.name}: not found`);
    }
  }
}

/** atomic write wrapper for JSON config files. Delegates to the shared helper. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2), 0o600);
}

async function installToConfig(path: string, entry: Record<string, any>): Promise<boolean> {
  // Three distinct paths:
  //   1. ENOENT  → fresh file, write a minimal config and return.
  //   2. read OK + parse OK → modify-existing path with RMW guard.
  //   3. read OK + parse FAIL → throw, caller logs Skipped. We deliberately do
  //      NOT overwrite a malformed file: third-party configs (notably
  //      `~/.claude.json`) carry many top-level keys we don't know about, and
  //      replacing the file with a fresh `{mcpServers: {elisym: ...}}` would
  //      destroy them. Force the user to fix the JSON manually.
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // Fresh file — no race to detect, just create it.
    await writeJsonAtomic(path, { mcpServers: { elisym: entry } });
    return true;
  }

  let config: any;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix the file manually and re-run install.`);
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers.elisym) {
    return false; // Already installed
  }

  config.mcpServers.elisym = entry;
  // RMW guard: existing file may be concurrently rewritten by the client itself
  // (e.g. Claude Code mutating ~/.claude.json). Abort rather than silently
  // clobber. The outer try/catch in runInstall surfaces this as a Skipped log.
  await safeRewriteJson(path, raw, config);
  return true;
}
