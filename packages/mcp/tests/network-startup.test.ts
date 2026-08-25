/**
 * Network selection at process startup (G6/H4 write-through + the D1 conflict
 * rule). Spawns the built `dist/index.js` like the stdio integration test:
 *
 *   - `init --network mainnet` writes `payments[].network: mainnet` (H4 - the
 *     old code echoed the chosen network while writing a devnet literal).
 *   - `ELISYM_NETWORK=mainnet` registers a mainnet-bound instance in BOTH
 *     ephemeral modes (provided-secret and no-agents auto-create).
 *   - `ELISYM_NETWORK` vs a disk-loaded agent's YAML network is a LOUD startup
 *     failure in both directions - never an override (network is fixed at
 *     agent creation).
 *
 * No relay or RPC traffic: agents are only registered, never used.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveAgentConfig } from '../src/config.js';

const DIST_ENTRY = join(__dirname, '..', 'dist', 'index.js');
const REQUEST_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 20_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Env for a spawned process: temp HOME, all elisym vars stripped, overrides applied. */
function spawnEnv(tmpHome: string, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.ELISYM_AGENT;
  delete env.ELISYM_AGENT_NAME;
  delete env.ELISYM_NOSTR_SECRET;
  delete env.ELISYM_NETWORK;
  delete env.ELISYM_PASSPHRASE;
  return { ...env, ...overrides };
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a one-shot CLI invocation (e.g. `init`) to completion. */
function runCli(
  tmpHome: string,
  args: string[],
  overrides: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const proc = spawn(process.execPath, [DIST_ENTRY, ...args], {
      cwd: tmpHome,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv(tmpHome, overrides),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${REQUEST_TIMEOUT_MS}ms.\nstderr: ${stderr}`));
    }, REQUEST_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdin.end();
  });
}

/** Minimal MCP stdio harness for server-mode spawns (subset of the stdio test's). */
class ServerHarness {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;
  stderrChunks: string[] = [];
  private exitCode: number | null | undefined;
  private exitWaiters: Array<(code: number | null) => void> = [];

  constructor(tmpHome: string, overrides: Record<string, string>) {
    this.proc = spawn(process.execPath, [DIST_ENTRY], {
      cwd: tmpHome,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv(tmpHome, overrides),
    });
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) {
          continue;
        }
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            cb(msg);
          }
        } catch {
          // Non-JSON stdout line: ignored here (covered by the stdio test).
        }
      }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });
    this.proc.on('exit', (code) => {
      this.exitCode = code;
      for (const waiter of this.exitWaiters) {
        waiter(code);
      }
      this.exitWaiters = [];
    });
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request ${method} timed out.\nstderr: ${this.stderrText}`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(frame + '\n');
    });
  }

  async initialize(): Promise<void> {
    const res = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'network-startup-test', version: '0.0.0' },
    });
    if (res.error) {
      throw new Error(`initialize failed: ${res.error.message}`);
    }
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  /** Wait for the process to exit on its own (startup-failure cases). */
  waitForExit(): Promise<number | null> {
    if (this.exitCode !== undefined) {
      return Promise.resolve(this.exitCode);
    }
    return new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`process did not exit within ${REQUEST_TIMEOUT_MS}ms - startup succeeded?`),
          ),
        REQUEST_TIMEOUT_MS,
      );
      this.exitWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async close(): Promise<void> {
    if (this.exitCode !== undefined) {
      return;
    }
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 2000);
      this.proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get stderrText(): string {
    return this.stderrChunks.join('');
  }
}

interface ListedAgent {
  name: string;
  network?: string;
  active: boolean;
}

/** Call list_agents over JSON-RPC and return the parsed agents array. */
async function listAgents(harness: ServerHarness): Promise<ListedAgent[]> {
  const response = await harness.send('tools/call', { name: 'list_agents', arguments: {} });
  expect(response.error).toBeUndefined();
  const result = response.result as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBeFalsy();
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { agents: ListedAgent[] };
  return parsed.agents;
}

/** Valid nonzero secp256k1 secret for ephemeral-identity spawns. */
const EPHEMERAL_SECRET_HEX = 'a'.repeat(64);

/** Write a disk agent bound to `network` into the temp HOME. */
async function writeDiskAgent(
  tmpHome: string,
  name: string,
  network: 'devnet' | 'mainnet',
): Promise<void> {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    await saveAgentConfig(name, {
      name,
      description: 'network-startup test agent',
      relays: ['wss://relay.damus.io'],
      // Valid nonzero scalar: the conflict paths exit before the identity is
      // built, but the happy path builds it for real.
      nostrSecretKey: '7'.repeat(64),
      // A wallet address is required for a payments[] entry to exist - the
      // network lives on that entry.
      solanaAddress: 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP',
      network,
    });
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalProfile;
  }
}

describe('network selection at startup', () => {
  let tmpHome: string;
  let harness: ServerHarness | null = null;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-mcp-network-'));
  });

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it(
    'init --network mainnet writes payments[].network: mainnet',
    async () => {
      const result = await runCli(tmpHome, [
        'init',
        'main-agent',
        '--network',
        'mainnet',
        '--passphrase',
        '',
        '-d',
        'test agent',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Network: mainnet/);
      const yaml = await readFile(join(tmpHome, '.elisym', 'main-agent', 'elisym.yaml'), 'utf8');
      expect(yaml).toMatch(/network: mainnet/);
      expect(yaml).not.toMatch(/network: devnet/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'init defaults to devnet when --network is omitted (explicit opt-in for mainnet)',
    async () => {
      const result = await runCli(tmpHome, ['init', 'dev-agent', '--passphrase', '', '-d', 'test']);
      expect(result.code).toBe(0);
      const yaml = await readFile(join(tmpHome, '.elisym', 'dev-agent', 'elisym.yaml'), 'utf8');
      expect(yaml).toMatch(/network: devnet/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'init rejects an unsupported network value',
    async () => {
      const result = await runCli(tmpHome, [
        'init',
        'bad-agent',
        '--network',
        'testnet',
        '--passphrase',
        '',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/devnet.*mainnet|mainnet.*devnet/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ELISYM_NETWORK=mainnet binds the provided-secret ephemeral agent to mainnet',
    async () => {
      harness = new ServerHarness(tmpHome, {
        ELISYM_NOSTR_SECRET: EPHEMERAL_SECRET_HEX,
        ELISYM_NETWORK: 'mainnet',
      });
      await harness.initialize();
      const agents = await listAgents(harness);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.network).toBe('mainnet');
      expect(harness.stderrText).toMatch(/Ephemeral agent: mcp-agent \(mainnet\)/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ELISYM_NETWORK=mainnet binds the no-agents auto-create fallback to mainnet',
    async () => {
      harness = new ServerHarness(tmpHome, { ELISYM_NETWORK: 'mainnet' });
      await harness.initialize();
      const agents = await listAgents(harness);
      expect(agents).toHaveLength(1);
      expect(agents[0]?.network).toBe('mainnet');
      expect(harness.stderrText).toMatch(/no persistent identity, mainnet/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an unsupported ELISYM_NETWORK value at startup',
    async () => {
      harness = new ServerHarness(tmpHome, {
        ELISYM_NOSTR_SECRET: EPHEMERAL_SECRET_HEX,
        ELISYM_NETWORK: 'testnet',
      });
      const code = await harness.waitForExit();
      expect(code).toBe(1);
      expect(harness.stderrText).toMatch(/ELISYM_NETWORK="testnet" is not supported/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails loud when ELISYM_NETWORK=mainnet targets a devnet disk agent (ELISYM_AGENT)',
    async () => {
      await writeDiskAgent(tmpHome, 'disk-devnet', 'devnet');
      harness = new ServerHarness(tmpHome, {
        ELISYM_AGENT: 'disk-devnet',
        ELISYM_NETWORK: 'mainnet',
      });
      const code = await harness.waitForExit();
      expect(code).toBe(1);
      expect(harness.stderrText).toMatch(/conflicts with agent "disk-devnet"/);
      expect(harness.stderrText).toMatch(/fixed at creation/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails loud when ELISYM_NETWORK=devnet targets a mainnet disk agent (the safety-belt direction)',
    async () => {
      await writeDiskAgent(tmpHome, 'disk-mainnet', 'mainnet');
      harness = new ServerHarness(tmpHome, {
        ELISYM_AGENT: 'disk-mainnet',
        ELISYM_NETWORK: 'devnet',
      });
      const code = await harness.waitForExit();
      expect(code).toBe(1);
      expect(harness.stderrText).toMatch(/conflicts with agent "disk-mainnet"/);
      expect(harness.stderrText).toMatch(/fixed at creation/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails loud on the default-from-disk path too (no ELISYM_AGENT set)',
    async () => {
      await writeDiskAgent(tmpHome, 'only-agent', 'devnet');
      harness = new ServerHarness(tmpHome, { ELISYM_NETWORK: 'mainnet' });
      const code = await harness.waitForExit();
      expect(code).toBe(1);
      expect(harness.stderrText).toMatch(/conflicts with agent "only-agent"/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a matching ELISYM_NETWORK is not a conflict: the disk agent loads normally',
    async () => {
      await writeDiskAgent(tmpHome, 'match-agent', 'mainnet');
      harness = new ServerHarness(tmpHome, {
        ELISYM_AGENT: 'match-agent',
        ELISYM_NETWORK: 'mainnet',
      });
      await harness.initialize();
      const agents = await listAgents(harness);
      expect(
        agents.some((agent) => agent.name === 'match-agent' && agent.network === 'mainnet'),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
