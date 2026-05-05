/**
 * MCP client driver for Phase 6 (Q3 - MCP discovery latency).
 *
 * Spawns @elisym/mcp once via stdio and reuses the connection across many
 * tool invocations. This mirrors how an assistant (Claude Desktop, Cursor,
 * Windsurf) actually consumes the server - a long-lived child process over
 * stdio with sequential JSON-RPC requests.
 *
 * One MCP child per bridge process. /mcp/start is idempotent (no-op if a
 * driver is already running). /mcp/stop tears the child down.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpStartOptions {
  /** elisym agent name (must already exist via `elisym init`). */
  agent: string;
  /** Override the spawned binary; defaults to `elisym-mcp`. */
  command?: string;
  /** Extra args appended after the binary. */
  args?: string[];
  /** Extra env merged on top of process.env. */
  env?: Record<string, string>;
}

export interface McpCallResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
  /** Whether the MCP-level result object had `isError: true`. */
  isToolError?: boolean;
  contentSummary?: string;
}

export class McpDriver {
  private transport: StdioClientTransport | null = null;
  private client: Client | null = null;
  private startedAt = 0;
  private callsTotal = 0;

  isRunning(): boolean {
    return this.client !== null;
  }

  uptimeMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  totalCalls(): number {
    return this.callsTotal;
  }

  async start(opts: McpStartOptions): Promise<void> {
    if (this.client) {
      return;
    }
    if (!opts.agent) {
      throw new Error('mcp-driver: agent is required');
    }
    const command = opts.command ?? 'elisym-mcp';
    const args = opts.args ?? [];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELISYM_AGENT: opts.agent,
      ...(opts.env ?? {}),
    };

    const transport = new StdioClientTransport({ command, args, env });
    const client = new Client(
      { name: '@elisym/perf-bridge', version: '0.0.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (err) {
      // connect can spawn the child but fail the handshake; tear it down so
      // we don't leak the process and isRunning() doesn't lie on retry.
      try {
        await transport.close();
      } catch {
        // ignore
      }
      throw err;
    }
    this.transport = transport;
    this.client = client;
    this.startedAt = Date.now();
    this.callsTotal = 0;
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
    }
    this.client = null;
    this.transport = null;
    this.startedAt = 0;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    if (!this.client) {
      return { ok: false, elapsedMs: 0, error: 'mcp-driver not started' };
    }
    const start = Date.now();
    try {
      const result = await this.client.callTool({ name, arguments: args });
      this.callsTotal++;
      const elapsedMs = Date.now() - start;
      const isToolError = (result as { isError?: boolean })?.isError === true;
      const content = Array.isArray((result as { content?: unknown[] }).content)
        ? ((result as { content: unknown[] }).content as { text?: string }[])
        : [];
      const contentSummary = content
        .filter((c) => typeof c?.text === 'string')
        .map((c) => String(c.text).slice(0, 200))
        .join(' | ')
        .slice(0, 400);
      return { ok: !isToolError, elapsedMs, isToolError, contentSummary };
    } catch (err) {
      const elapsedMs = Date.now() - start;
      return {
        ok: false,
        elapsedMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
