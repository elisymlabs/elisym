/**
 * Auto-install elisym MCP server into Claude Desktop, Cursor, Windsurf configs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { validateAgentName } from '@elisym/sdk';
import { writeFileAtomic } from './atomic-write.js';
import { PACKAGE_VERSION } from './utils.js';

interface McpClient {
  name: string;
  configPath: () => string | null;
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
    args: ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`],
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

export async function runUninstall(options: { client?: string }): Promise<void> {
  for (const client of CLIENTS) {
    if (options.client && client.name !== options.client) {
      continue;
    }

    const path = client.configPath();
    if (!path) {
      continue;
    }

    try {
      const raw = await readFile(path, 'utf-8');
      const config = JSON.parse(raw);
      if (config.mcpServers?.elisym) {
        delete config.mcpServers.elisym;
        // atomic write via tmp+rename to avoid corrupting the client config on crash.
        await writeJsonAtomic(path, config);
        console.log(`Removed from ${client.name}: ${path}`);
      }
    } catch {
      // File doesn't exist or can't be read
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
  let config: any;
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    if (raw !== undefined) {
      console.error(
        `Warning: ${path} is not valid JSON. A backup was saved to ${path}.elisym-backup. ` +
          `Other MCP server entries may have been lost - restore from backup if needed.`,
      );
    }
    config = {};
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers.elisym) {
    return false; // Already installed
  }

  // Best-effort backup before modifying a third-party config file.
  if (raw) {
    try {
      await writeFile(`${path}.elisym-backup`, raw, { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  config.mcpServers.elisym = entry;
  await writeJsonAtomic(path, config);
  return true;
}
