/**
 * Auto-install elisym MCP server into MCP client configs.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { validateAgentName } from '@elisym/sdk';
import { listAgents } from '@elisym/sdk/agent-store';
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
  format: 'json' | 'codex-toml';
  configPath: () => string | null;
}

function userHome(): string {
  return process.env.HOME ?? homedir();
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
  // Known, ACCEPTED residual TOCTOU: a concurrent writer could still land
  // between this recheck and the rename(2) below. The recheck converts the
  // common case (client rewrote the file while we were mutating it) into a
  // visible "modified during update" error instead of silent data loss; a
  // complete fix would require advisory file locking (proper-lockfile / flock),
  // a dependency we intentionally do not add here.
  await writeJsonAtomic(path, newConfig);
}

const CLIENTS: McpClient[] = [
  {
    name: 'claude-desktop',
    format: 'json',
    configPath() {
      const home = userHome();
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
    format: 'json',
    // Claude Code CLI keeps user-scope MCP servers under `mcpServers` at the top
    // level of `~/.claude.json`. Project-scope (`.mcp.json` in cwd) and local-scope
    // (`projects.<path>.mcpServers` inside the same file) are deliberately not
    // touched here - this installer only writes user scope so the server is
    // available across all projects.
    configPath: () => join(userHome(), '.claude.json'),
  },
  {
    name: 'cursor',
    format: 'json',
    configPath: () => join(userHome(), '.cursor/mcp.json'),
  },
  {
    name: 'codex',
    format: 'codex-toml',
    configPath: () => join(userHome(), '.codex/config.toml'),
  },
  {
    name: 'windsurf',
    format: 'json',
    configPath() {
      const home = userHome();
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

  // No --agent → try to pick a sensible default from the user's agent store.
  // 0 agents: fall through with no binding (server will run unbound).
  // 1 agent : auto-bind, log so the user sees which one was chosen.
  // ≥2      : refuse to guess; print the list and ask for an explicit --agent.
  let effectiveAgent = options.agent;
  if (effectiveAgent === undefined) {
    const resolved = await resolveDefaultAgent();
    if (resolved.kind === 'ambiguous') {
      console.log(
        `Multiple agents found (${resolved.names.join(', ')}). ` +
          `Re-run with --agent <name> to choose one.`,
      );
      return;
    }
    if (resolved.kind === 'single') {
      effectiveAgent = resolved.name;
      console.log(`Auto-bound to agent "${effectiveAgent}".`);
    }
  }

  const entry = buildServerEntry(effectiveAgent, options.env);
  let installed = 0;
  let rebound = 0;

  for (const client of CLIENTS) {
    if (options.client && client.name !== options.client) {
      continue;
    }

    const path = client.configPath();
    if (!path) {
      continue;
    }

    try {
      const result =
        client.format === 'codex-toml'
          ? await installToCodexConfig(path, entry, options.agent)
          : await installToConfig(path, entry, options.agent);
      if (result === 'installed') {
        console.log(`Installed to ${client.name}: ${path}`);
        installed++;
      } else if (result === 'rebound') {
        console.log(`Rebound ${client.name} to agent "${effectiveAgent}": ${path}`);
        rebound++;
      } else {
        console.log(`Already installed in ${client.name}`);
      }
    } catch (e: any) {
      console.log(`Skipped ${client.name}: ${e.message}`);
    }
  }

  if (installed === 0 && rebound === 0 && !options.client) {
    console.log('No MCP clients found to install into.');
  }
}

type DefaultAgentResolution =
  | { kind: 'none' }
  | { kind: 'single'; name: string }
  | { kind: 'ambiguous'; names: string[] };

async function resolveDefaultAgent(): Promise<DefaultAgentResolution> {
  const agents = await listAgents(userHome());
  const [first, second] = agents;
  if (!first) {
    return { kind: 'none' };
  }
  if (!second) {
    return { kind: 'single', name: first.name };
  }
  return { kind: 'ambiguous', names: agents.map((agent) => agent.name) };
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
    if (client.format === 'codex-toml') {
      try {
        const result = await updateCodexConfig(path, options.agent);
        if (result === 'updated') {
          console.log(`Updated ${client.name}: ${path} -> @elisym/mcp@~${PACKAGE_VERSION}`);
          updated++;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.log(`Skipped ${client.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

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
    const packageArg = newArgs[1];
    if (packageArg === undefined) {
      throw new Error('Internal error: missing package argument for elisym MCP install.');
    }
    if (Array.isArray(entry.args)) {
      // Find the existing `@elisym/mcp@...` token and replace it in place so
      // any user-added flags around it survive. If for some reason it's not
      // there (hand-edited entry), fall back to overwriting `args` wholesale —
      // we still need to land the new pin.
      const idx = entry.args.findIndex(
        (a: unknown) => typeof a === 'string' && a.startsWith('@elisym/mcp@'),
      );
      if (idx >= 0) {
        entry.args[idx] = packageArg;
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

    if (client.format === 'codex-toml') {
      try {
        const result = await uninstallFromCodexConfig(path);
        if (result === 'removed') {
          console.log(`Removed from ${client.name}: ${path}`);
        }
      } catch {
        // Keep uninstall quiet for missing or unreadable clients, matching JSON clients.
      }
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
      const installed =
        client.format === 'codex-toml'
          ? findCodexElisymBlock(raw) !== null
          : !!JSON.parse(raw).mcpServers?.elisym;
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

type InstallResult = 'installed' | 'rebound' | 'unchanged';

async function installToConfig(
  path: string,
  entry: Record<string, any>,
  agentRebind: string | undefined,
): Promise<InstallResult> {
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
    return 'installed';
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

  const existing = config.mcpServers.elisym;
  if (existing) {
    // Already installed. Without --agent, install is a no-op (the user must
    // explicitly opt into rebinding). With --agent, rewrite ELISYM_AGENT in
    // place — preserving args/command/sibling env so customizations survive.
    if (agentRebind === undefined) {
      return 'unchanged';
    }
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      return 'unchanged';
    }
    const rawEnv = (existing as { env?: unknown }).env;
    const currentEnv: Record<string, string> =
      rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
        ? { ...(rawEnv as Record<string, string>) }
        : {};
    if (currentEnv.ELISYM_AGENT === agentRebind) {
      return 'unchanged';
    }
    currentEnv.ELISYM_AGENT = agentRebind;
    (existing as Record<string, any>).env = currentEnv;
    await safeRewriteJson(path, raw, config);
    return 'rebound';
  }

  config.mcpServers.elisym = entry;
  // RMW guard: existing file may be concurrently rewritten by the client itself
  // (e.g. Claude Code mutating ~/.claude.json). Abort rather than silently
  // clobber. The outer try/catch in runInstall surfaces this as a Skipped log.
  await safeRewriteJson(path, raw, config);
  return 'installed';
}

type CodexUpdateResult = 'updated' | 'unchanged';
type CodexUninstallResult = 'removed' | 'unchanged';

interface CodexBlock {
  start: number;
  end: number;
  body: string;
}

interface TomlTableRange {
  start: number;
  end: number;
  path: string;
}

function findCodexElisymBlock(raw: string): CodexBlock | null {
  const table = findTomlTableRange(raw, 'mcp_servers.elisym');
  if (!table) {
    return null;
  }
  return { start: table.start, end: table.end, body: raw.slice(table.start, table.end) };
}

function findTomlTableRange(raw: string, path: string): TomlTableRange | null {
  return findTomlTableRanges(raw).find((table) => table.path === path) ?? null;
}

function findTomlTableRanges(raw: string): TomlTableRange[] {
  const lines = raw.match(/^.*(?:\n|$)/gm) ?? [];
  const offsets: number[] = [];
  let offset = 0;

  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  const ranges: TomlTableRange[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const path = parseTomlTableHeader(line);
    if (!path) {
      continue;
    }

    let end = raw.length;
    for (let nextLineIndex = lineIndex + 1; nextLineIndex < lines.length; nextLineIndex++) {
      if (parseTomlTableHeader(lines[nextLineIndex] ?? '')) {
        end = offsets[nextLineIndex] ?? raw.length;
        break;
      }
    }
    ranges.push({ start: offsets[lineIndex] ?? 0, end, path });
  }

  return ranges;
}

function parseTomlTableHeader(line: string): string | null {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line.trimEnd());
  return match ? match[1] : null;
}

function parseCodexEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  let section: 'elisym' | 'env' | 'other' = 'other';

  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (/^\[mcp_servers\.elisym\]\s*(?:#.*)?$/.test(trimmed)) {
        section = 'elisym';
      } else if (/^\[mcp_servers\.elisym\.env\]\s*(?:#.*)?$/.test(trimmed)) {
        section = 'env';
      } else {
        section = 'other';
      }
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (section === 'elisym') {
      Object.assign(env, parseCodexInlineEnv(trimmed));
    } else if (section === 'env') {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(trimmed);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      const value = parseTomlString(rawValue);
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  return env;
}

function parseCodexInlineEnv(line: string): Record<string, string> {
  const env: Record<string, string> = {};
  const match = /^env\s*=\s*\{(.*)\}\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return env;
  }

  const [, body] = match;
  for (const entry of splitInlineTableEntries(body)) {
    const entryMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(entry);
    if (!entryMatch) {
      continue;
    }
    const [, key, rawValue] = entryMatch;
    const value = parseTomlString(rawValue);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function splitInlineTableEntries(body: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inString = false;
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inString = !inString;
      continue;
    }
    if (char === ',' && !inString) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim() !== '') {
    entries.push(current);
  }

  return entries;
}

function parseTomlString(rawValue: string): string | undefined {
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }
  try {
    return JSON.parse(rawValue) as string;
  } catch {
    return undefined;
  }
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlStringArray(values: string[]): string {
  return `[${values.map((value) => quoteTomlString(value)).join(', ')}]`;
}

function renderCodexTomlBlock(entry: Record<string, any>): string {
  const lines = [
    '[mcp_servers.elisym]',
    `command = ${quoteTomlString(String(entry.command ?? 'npx'))}`,
    `args = ${renderTomlStringArray(Array.isArray(entry.args) ? entry.args.map(String) : [])}`,
  ];

  const env =
    entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? (entry.env as Record<string, string>)
      : {};
  const envEntries = Object.entries(env);
  if (envEntries.length > 0) {
    lines.push('', '[mcp_servers.elisym.env]');
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${quoteTomlString(String(value))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function updateCodexTomlBlock(
  body: string,
  env: Record<string, string>,
  rewriteEnv: boolean,
): string {
  const withFreshPackagePin = updateCodexPackagePin(body);
  if (!rewriteEnv) {
    return withFreshPackagePin;
  }
  const agent = env.ELISYM_AGENT;
  if (agent === undefined) {
    return withFreshPackagePin;
  }
  return replaceCodexAgentEnv(withFreshPackagePin, agent);
}

function updateCodexPackagePin(body: string): string {
  const lines = body.match(/^.*(?:\n|$)/gm) ?? [];
  let section: 'elisym' | 'env' | 'other' = 'other';

  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (/^\[mcp_servers\.elisym\]\s*(?:#.*)?$/.test(trimmed)) {
        section = 'elisym';
      } else if (/^\[mcp_servers\.elisym\.env\]\s*(?:#.*)?$/.test(trimmed)) {
        section = 'env';
      } else {
        section = 'other';
      }
      continue;
    }

    if (section !== 'elisym' || !/^\s*args\s*=/.test(line)) {
      continue;
    }

    const packageSpec = `@elisym/mcp@~${PACKAGE_VERSION}`;
    const assignmentEndIndex = findTomlAssignmentEnd(lines, lineIndex);
    const assignmentLines = lines.slice(lineIndex, assignmentEndIndex + 1);
    const packageLineOffset = assignmentLines.findIndex((assignmentLine) =>
      assignmentLine.includes('@elisym/mcp@'),
    );
    if (packageLineOffset >= 0) {
      const packageLineIndex = lineIndex + packageLineOffset;
      const packageLine = lines[packageLineIndex] ?? '';
      lines[packageLineIndex] = packageLine.replace(/@elisym\/mcp@[^"\],\s]+/, packageSpec);
    } else {
      lines.splice(
        lineIndex,
        assignmentEndIndex - lineIndex + 1,
        replaceTomlAssignmentValue(line, renderTomlStringArray(elisymPackageArgs())),
      );
    }
    break;
  }

  return lines.join('');
}

function findTomlAssignmentEnd(lines: string[], startIndex: number): number {
  const firstLine = lines[startIndex] ?? '';
  const assignmentStart = firstLine.indexOf('=');
  if (assignmentStart < 0) {
    return startIndex;
  }

  let depth = 0;
  let sawArray = false;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    if (lineIndex > startIndex && /^\s*\[/.test(line) && depth > 0) {
      return lineIndex - 1;
    }

    const scanFrom = lineIndex === startIndex ? assignmentStart + 1 : 0;
    const scan = scanTomlArrayLine(line, scanFrom, depth);
    depth = scan.depth;
    sawArray = sawArray || scan.sawArray;

    if (!sawArray) {
      return startIndex;
    }
    if (depth <= 0) {
      return lineIndex;
    }
  }

  return lines.length - 1;
}

function scanTomlArrayLine(
  line: string,
  startIndex: number,
  initialDepth: number,
): { depth: number; sawArray: boolean } {
  let depth = initialDepth;
  let sawArray = false;
  let inString = false;
  let escaped = false;

  for (let charIndex = startIndex; charIndex < line.length; charIndex++) {
    const char = line[charIndex];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === '#' && !inString) {
      break;
    }
    if (char === '[' && !inString) {
      depth++;
      sawArray = true;
    } else if (char === ']' && !inString) {
      depth--;
    }
  }

  return { depth, sawArray };
}

function replaceTomlAssignmentValue(line: string, value: string): string {
  const match = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*).*(\r?\n)?$/.exec(line);
  if (!match) {
    return line;
  }
  const [, prefix, newline = ''] = match;
  return `${prefix}${value}${newline}`;
}

function replaceCodexAgentEnv(body: string, agent: string): string {
  const lines = body.match(/^.*(?:\n|$)/gm) ?? [];
  let section: 'elisym' | 'env' | 'other' = 'other';
  let envInsertionIndex = -1;
  let elisymInsertionIndex = -1;

  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (section === 'env' && envInsertionIndex < 0) {
        envInsertionIndex = lineIndex;
      }
      if (section === 'elisym') {
        elisymInsertionIndex = lineIndex;
      }

      const header = parseTomlTableHeader(trimmed);
      if (header === 'mcp_servers.elisym') {
        section = 'elisym';
      } else if (header === 'mcp_servers.elisym.env') {
        section = 'env';
        continue;
      } else {
        section = 'other';
      }
    }

    if (section === 'env') {
      if (/^\s*ELISYM_AGENT\s*=/.test(line)) {
        lines[lineIndex] = replaceTomlAssignmentValue(line, quoteTomlString(agent));
        return lines.join('');
      }
      continue;
    }
    if (section === 'elisym') {
      elisymInsertionIndex = lineIndex + 1;
      if (/^\s*env\s*=/.test(line)) {
        const nextLine = replaceCodexInlineEnvAgent(line, agent);
        if (nextLine !== null) {
          lines[lineIndex] = nextLine;
          return lines.join('');
        }
      }
    }
  }

  if (section === 'env') {
    envInsertionIndex = lines.length;
  } else if (section === 'elisym') {
    elisymInsertionIndex = lines.length;
  }

  const agentLine = `ELISYM_AGENT = ${quoteTomlString(agent)}\n`;
  if (envInsertionIndex >= 0) {
    lines.splice(envInsertionIndex, 0, agentLine);
    return lines.join('');
  }
  const insertionIndex = elisymInsertionIndex >= 0 ? elisymInsertionIndex : lines.length;
  lines.splice(insertionIndex, 0, '\n', '[mcp_servers.elisym.env]\n', agentLine);
  return lines.join('');
}

function replaceCodexInlineEnvAgent(line: string, agent: string): string | null {
  const match = /^(\s*env\s*=\s*\{)(.*)(\}\s*(?:#.*)?(?:\r?\n)?)$/.exec(line);
  if (!match) {
    return null;
  }

  const [, prefix, body, suffix] = match;
  const entries = splitInlineTableEntries(body);
  const nextEntries: string[] = [];
  let replaced = false;

  for (const entry of entries) {
    if (/^\s*ELISYM_AGENT\s*=/.test(entry)) {
      const entryMatch = /^(\s*ELISYM_AGENT\s*=\s*).*$/.exec(entry);
      if (!entryMatch) {
        return null;
      }
      nextEntries.push(`${entryMatch[1]}${quoteTomlString(agent)}`);
      replaced = true;
    } else {
      nextEntries.push(entry);
    }
  }

  if (!replaced) {
    nextEntries.push(` ELISYM_AGENT = ${quoteTomlString(agent)} `);
  }

  return `${prefix}${nextEntries.join(',')}${suffix}`;
}

function removeCodexElisymTables(raw: string): string {
  const ranges = findTomlTableRanges(raw)
    .filter((table) => isCodexElisymPath(table.path))
    .sort((left, right) => right.start - left.start);

  let nextRaw = raw;
  for (const range of ranges) {
    nextRaw = `${nextRaw.slice(0, range.start)}${nextRaw.slice(range.end)}`;
  }
  return nextRaw;
}

function isCodexElisymPath(path: string): boolean {
  return path === 'mcp_servers.elisym' || path.startsWith('mcp_servers.elisym.');
}

function replaceCodexBlock(raw: string, block: CodexBlock | null, replacement: string): string {
  if (!block) {
    let separator = '\n\n';
    if (raw.length === 0 || raw.endsWith('\n\n')) {
      separator = '';
    } else if (raw.endsWith('\n')) {
      separator = '\n';
    }
    return `${raw}${separator}${replacement}`;
  }
  return `${raw.slice(0, block.start)}${replacement}${raw.slice(block.end)}`;
}

async function installToCodexConfig(
  path: string,
  entry: Record<string, any>,
  agentRebind: string | undefined,
): Promise<InstallResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, renderCodexTomlBlock(entry), 0o600);
    return 'installed';
  }

  const block = findCodexElisymBlock(raw);
  if (block) {
    if (agentRebind === undefined) {
      return 'unchanged';
    }
    const env = parseCodexEnv(raw);
    if (env.ELISYM_AGENT === agentRebind) {
      return 'unchanged';
    }
    env.ELISYM_AGENT = agentRebind;
    const replacement = updateCodexTomlBlock(raw, env, true);
    await safeRewriteRaw(path, raw, replacement);
    return 'rebound';
  }

  await safeRewriteRaw(path, raw, replaceCodexBlock(raw, null, renderCodexTomlBlock(entry)));
  return 'installed';
}

async function updateCodexConfig(
  path: string,
  agentOverride: string | undefined,
): Promise<CodexUpdateResult> {
  const raw = await readFile(path, 'utf-8');
  const block = findCodexElisymBlock(raw);
  if (!block) {
    return 'unchanged';
  }

  const env = parseCodexEnv(raw);
  const existingAgentRaw = typeof env.ELISYM_AGENT === 'string' ? env.ELISYM_AGENT : undefined;
  if (existingAgentRaw !== undefined && agentOverride === undefined) {
    validateAgentName(existingAgentRaw);
  }
  if (agentOverride !== undefined) {
    env.ELISYM_AGENT = agentOverride;
  }

  const replacement = updateCodexTomlBlock(raw, env, agentOverride !== undefined);
  await safeRewriteRaw(path, raw, replacement);
  return 'updated';
}

async function uninstallFromCodexConfig(path: string): Promise<CodexUninstallResult> {
  const raw = await readFile(path, 'utf-8');
  const replacement = removeCodexElisymTables(raw);
  if (replacement === raw) {
    return 'unchanged';
  }
  await safeRewriteRaw(path, raw, replacement);
  return 'removed';
}

async function safeRewriteRaw(path: string, expectedRaw: string, nextRaw: string): Promise<void> {
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
  await writeFileAtomic(path, nextRaw, 0o600);
}
