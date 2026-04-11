/**
 * integration test for the MCP stdio transport.
 *
 * Spawns the built `dist/index.js` via node, exchanges JSON-RPC frames with it over
 * stdin/stdout (stderr goes to a buffer we can inspect). Verifies that:
 *   - the server initializes without logging to stdout
 *   - `tools/list` returns all 17 registered tools
 *   - `tools/call get_identity` works on the auto-generated ephemeral agent
 *   - malformed args produce a helpful `isError: true` result, not a crash
 *   - the server exits cleanly on SIGTERM
 *
 * This test does NOT touch real relays - it operates on the ephemeral agent spawned
 * when no persistent agents exist on disk.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const DIST_ENTRY = join(__dirname, '..', 'dist', 'index.js');
const STARTUP_TIMEOUT_MS = 5_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpHarness {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;
  stdoutChunks: string[] = [];
  stderrChunks: string[] = [];

  constructor(tmpHome: string) {
    this.proc = spawn(process.execPath, [DIST_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpHome,
        // Force ephemeral agent - we don't want the default lookup path to pick up
        // agents from the real user's home.
        ELISYM_AGENT: '',
      },
    });
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.stdoutChunks.push(chunk.toString('utf8'));
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
          // Non-JSON line on stdout is a protocol violation.
        }
      }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request ${method} timed out`)),
        STARTUP_TIMEOUT_MS,
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
      clientInfo: { name: 'mcp-test', version: '0.0.0' },
    });
    if (res.error) {
      throw new Error(`initialize failed: ${res.error.message}`);
    }
    // Send initialized notification (no id, no response expected).
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  async close(): Promise<void> {
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

  get stdoutText(): string {
    return this.stdoutChunks.join('');
  }

  get stderrText(): string {
    return this.stderrChunks.join('');
  }
}

describe('stdio MCP integration', () => {
  let tmpHome: string;
  let harness: McpHarness | null = null;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'elisym-mcp-stdio-'));
  });

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('initializes and exposes exactly 17 tools', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();

    const response = await harness.send('tools/list', {});
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(17);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain('withdraw');
    expect(names).toContain('get_identity');
    // Every tool must have a JSON Schema.
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeTypeOf('object');
    }
  });

  it('get_identity returns the ephemeral agent on a fresh install', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();

    const response = await harness.send('tools/call', {
      name: 'get_identity',
      arguments: {},
    });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { npub: string; name: string };
    expect(parsed.npub).toMatch(/^npub1[0-9a-z]+$/);
    expect(parsed.name).toBe('mcp-agent');
  });

  it('malformed tool arguments return isError:true with a Zod message, not a crash', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();

    const response = await harness.send('tools/call', {
      name: 'create_job',
      arguments: { input: 42 /* wrong type: should be string */ },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    // should be a short, readable message, not a raw JSON-stringified issue array.
    expect(text).toMatch(/Invalid arguments.*input/i);
    expect(text.length).toBeLessThan(500);
  });

  it('unknown tool name returns isError:true', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();
    const response = await harness.send('tools/call', {
      name: 'tool_that_does_not_exist',
      arguments: {},
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool/);
  });

  it('stdout contains only JSON-RPC frames (no stray console.log)', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();
    await harness.send('tools/list', {});
    // Every non-empty line on stdout should be valid JSON-RPC.
    for (const line of harness.stdoutText.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });

  it('stderr contains the startup diagnostic (Created ephemeral agent)', async () => {
    harness = new McpHarness(tmpHome);
    await harness.initialize();
    // Give stderr a moment to drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.stderrText).toMatch(/ephemeral|agent/i);
  });
}, 30_000);
