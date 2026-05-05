#!/usr/bin/env bun
import {
  ElisymClient,
  RELAYS,
  getProtocolConfig,
  getProtocolProgramId,
  type Network,
  type ProtocolCluster,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
/**
 * @elisym/perf bridge.
 *
 * Thin HTTP wrapper around @elisym/sdk so k6 scenarios can drive real SDK
 * code paths without embedding TypeScript in k6 (k6 cannot run TS / Node
 * imports). Also exposes a /metrics endpoint so prom-client gauges land in
 * the perf-stack Prometheus alongside k6 metrics.
 *
 * Routes:
 *   GET  /healthz                quick liveness probe
 *   GET  /metrics                prom-client output
 *   POST /discover               { network?, limit? } -> { agents, elapsedMs }
 *   POST /protocol-config        { rpcUrl?, network? } -> { config, cached, elapsedMs }
 *
 * Run:
 *   bun --hot packages/perf/bridge/src/server.ts
 *   PORT=3030 RELAYS=ws://localhost:7777 RPC_URL=http://localhost:8899 ...
 *
 * Stop with SIGINT.
 */
import { Hono } from 'hono';
import { FleetSimulator } from './fleet.js';
import { IdentityPool } from './identity-pool.js';
import { McpDriver } from './mcp-driver.js';
import { createBridgeMetrics } from './metrics.js';

const PORT = Number.parseInt(process.env.PORT ?? '3030', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const RELAYS_ENV = (process.env.RELAYS ?? '').trim();
const RELAY_LIST = RELAYS_ENV.length > 0 ? RELAYS_ENV.split(',') : RELAYS;
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899';
const NETWORK_ENV = (process.env.NETWORK ?? 'devnet') as ProtocolCluster;
const POOL_SIZE = Number.parseInt(process.env.IDENTITY_POOL_SIZE ?? '128', 10);

const metrics = createBridgeMetrics();
const identityPool = new IdentityPool(POOL_SIZE);
const client = new ElisymClient({ relays: RELAY_LIST });
const rpc = createSolanaRpc(RPC_URL);

let fleet: FleetSimulator | null = null;
const mcp = new McpDriver();

const app = new Hono();

function instrument<T extends object>(
  route: string,
  fn: () => Promise<T>,
): Promise<{ body: T; elapsedMs: number }> {
  const startTime = Date.now();
  const stopTimer = metrics.callDuration.startTimer({ route });
  return fn()
    .then((body) => {
      const elapsedMs = Date.now() - startTime;
      stopTimer();
      metrics.callsTotal.inc({ route, outcome: 'ok' });
      return { body, elapsedMs };
    })
    .catch((err) => {
      stopTimer();
      metrics.callsTotal.inc({ route, outcome: 'error' });
      throw err;
    });
}

app.get('/healthz', (c) => c.text('ok'));

app.get('/metrics', async (c) => {
  const body = await metrics.registry.metrics();
  return c.text(body, 200, { 'Content-Type': metrics.registry.contentType });
});

app.post('/discover', async (c) => {
  let payload: { network?: ProtocolCluster; limit?: number };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const network = payload.network ?? NETWORK_ENV;
  const limit = payload.limit;

  const result = await instrument('discover', async () => {
    // discovery's logical Network is mainnet|devnet; localnet falls back to
    // devnet semantics since the on-chain config is the only thing that
    // differs and we read that separately.
    const discoveryNetwork: Network = network === 'mainnet' ? 'mainnet' : 'devnet';
    const agents = await client.discovery.fetchAgents(discoveryNetwork, limit);
    return {
      count: agents.length,
      // truncated payload: k6 only needs the count + a sample for sanity
      sample: agents.slice(0, 3).map((a) => ({ pubkey: a.pubkey, lastSeen: a.lastSeen })),
    };
  });
  return c.json({ ...result.body, elapsedMs: result.elapsedMs });
});

// ---- /stream-discover (Phase 5: Q2 web latency) ----
//
// Mirrors what `useAgents` / `streamAgents` does in packages/app:
//   - subscribe to NIP-89 capability events for elisym agents
//   - the SDK fires onAgent for every new pubkey -> "first card visible"
//   - the SDK fires onEose when all relays have replied
//   - background enrichment (kind:0) eventually calls onComplete with the
//     ranked snapshot.
//
// k6 scenarios call this endpoint and read back a timeline of milestones,
// turning "what does a user wait for?" into precise numbers without having
// to render a browser.
app.post('/stream-discover', async (c) => {
  let payload: { network?: ProtocolCluster; timeoutMs?: number; sampleEveryN?: number };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const network = payload.network ?? NETWORK_ENV;
  const timeoutMs = Math.max(500, Math.min(payload.timeoutMs ?? 30_000, 120_000));
  const sampleEveryN = Math.max(1, payload.sampleEveryN ?? 10);
  const discoveryNetwork: Network = network === 'mainnet' ? 'mainnet' : 'devnet';

  const result = await instrument('stream-discover', async () => {
    const start = Date.now();
    const milestones: { event: string; deltaMs: number; index?: number }[] = [];
    let firstAgentDeltaMs: number | undefined;
    let count = 0;

    const closer = client.discovery.streamAgents(discoveryNetwork, {
      onAgent: () => {
        count++;
        if (firstAgentDeltaMs === undefined) {
          firstAgentDeltaMs = Date.now() - start;
          milestones.push({ event: 'first-agent', deltaMs: firstAgentDeltaMs, index: 1 });
        }
        if (count % sampleEveryN === 0) {
          milestones.push({ event: 'n-agents', deltaMs: Date.now() - start, index: count });
        }
      },
      onEose: () => {
        milestones.push({ event: 'eose', deltaMs: Date.now() - start });
      },
      onComplete: (agents) => {
        milestones.push({
          event: 'complete',
          deltaMs: Date.now() - start,
          index: agents.length,
        });
      },
    });

    // Wait until either onComplete fires or timeoutMs elapses, whichever first.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (milestones.some((m) => m.event === 'complete')) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, timeoutMs);
    });
    closer.close();

    return {
      finalCount: count,
      firstAgentDeltaMs,
      milestones,
      timedOut: !milestones.some((m) => m.event === 'complete'),
    };
  });

  return c.json({ ...result.body, elapsedMs: result.elapsedMs });
});

app.post('/protocol-config', async (c) => {
  let payload: { rpcUrl?: string; network?: ProtocolCluster };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const network = payload.network ?? NETWORK_ENV;
  const callRpc = payload.rpcUrl ? createSolanaRpc(payload.rpcUrl) : rpc;

  const result = await instrument('protocol-config', async () => {
    const programId = getProtocolProgramId(network);
    const config = await getProtocolConfig(callRpc, programId);
    return { config };
  });
  return c.json({ ...result.body, elapsedMs: result.elapsedMs });
});

app.get('/pool/info', (c) =>
  c.json({
    identitySize: identityPool.size(),
    relays: RELAY_LIST,
    rpcUrl: RPC_URL,
    network: NETWORK_ENV,
  }),
);

// ---- Fleet routes (Phase 4: Q1 - agent fleet scale) ----
//
// The fleet simulator publishes synthetic NIP-89 announcements so discovery
// scenarios can sweep "how does fetchAgents latency grow with N online agents".
// The fleet is a single shared resource per bridge process - one scenario at
// a time.
app.post('/fleet/resize', async (c) => {
  let payload: {
    size?: number;
    capability?: string;
    pingIntervalMs?: number;
    republishMs?: number;
  };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const size = Number(payload.size ?? 0);
  if (!Number.isInteger(size) || size < 0) {
    return c.json({ error: 'size must be a non-negative integer' }, 400);
  }
  if (!fleet) {
    fleet = new FleetSimulator({
      capability: payload.capability ?? 'translate',
      relays: RELAY_LIST,
      pingIntervalMs: payload.pingIntervalMs ?? 30_000,
      republishMs: payload.republishMs ?? 120_000,
    });
  }
  const fleetRef = fleet;
  const result = await instrument('fleet-resize', async () => {
    const snap = await fleetRef.resize(size);
    return snap;
  });
  return c.json({ ...result.body, elapsedMs: result.elapsedMs });
});

app.post('/fleet/stop', (c) => {
  if (!fleet) {
    return c.json({ size: 0, stopped: true });
  }
  const snap = fleet.stop();
  fleet = null;
  return c.json({ ...snap, stopped: true });
});

app.get('/fleet/info', (c) => c.json(fleet ? fleet.snapshot() : { size: 0 }));

// ---- MCP routes (Phase 6: Q3 - MCP discovery latency) ----
//
// One MCP child process per bridge instance. The driver mirrors how a real
// assistant client (Claude Desktop, Cursor, Windsurf) consumes elisym-mcp:
// long-lived stdio connection + sequential JSON-RPC tool calls.
app.post('/mcp/start', async (c) => {
  let payload: { agent?: string; command?: string; env?: Record<string, string> };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const agent = payload.agent ?? process.env.MCP_AGENT;
  if (!agent) {
    return c.json({ error: 'agent is required (in body or MCP_AGENT env)' }, 400);
  }
  if (mcp.isRunning()) {
    return c.json({ alreadyRunning: true, uptimeMs: mcp.uptimeMs() });
  }
  try {
    await mcp.start({ agent, command: payload.command, env: payload.env });
    return c.json({ started: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/mcp/call', async (c) => {
  let payload: { tool?: string; args?: Record<string, unknown> };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  if (!payload.tool) {
    return c.json({ error: 'tool is required' }, 400);
  }
  if (!mcp.isRunning()) {
    return c.json({ error: 'mcp not started; POST /mcp/start first' }, 400);
  }
  const tool = payload.tool;
  const args = payload.args ?? {};
  const wrapped = await instrument('mcp-call', async () => mcp.callTool(tool, args));
  return c.json({ ...wrapped.body, bridgeElapsedMs: wrapped.elapsedMs });
});

app.post('/mcp/stop', async (c) => {
  await mcp.stop();
  return c.json({ stopped: true });
});

app.get('/mcp/info', (c) =>
  c.json({
    running: mcp.isRunning(),
    uptimeMs: mcp.uptimeMs(),
    totalCalls: mcp.totalCalls(),
  }),
);

// ---- /job/submit (Phase 7: Q4 - provider saturation) ----
//
// Publishes a broadcast (un-targeted) job-request event so any provider
// listening for the capability picks it up. Uses a customer identity from
// the round-robin pool so the per-customer rate limiter on the provider
// (20 jobs / 10 min) does not trip until the pool itself wraps around.
app.post('/job/submit', async (c) => {
  let payload: { capability?: string; input?: string; providerPubkey?: string };
  try {
    payload = await c.req.json();
  } catch {
    payload = {};
  }
  const capability = payload.capability ?? 'translate';
  const input = payload.input ?? `perf job ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const wrapped = await instrument('job-submit', async () => {
    const entry = identityPool.next();
    const jobEventId = await client.marketplace.submitJobRequest(entry.identity, {
      input,
      capability,
      providerPubkey: payload.providerPubkey,
    });
    return { jobEventId, customerPubkey: entry.pubkeyHex };
  });
  return c.json({ ...wrapped.body, elapsedMs: wrapped.elapsedMs });
});

// Bun-native server. Bridge runs only under bun (the monorepo's runtime),
// so we avoid pulling in @hono/node-server.
const server = Bun.serve({ fetch: app.fetch, port: PORT, hostname: HOST });
process.stdout.write(`bridge: http://${server.hostname}:${server.port}\n`);
process.stdout.write(`  relays: ${RELAY_LIST.join(', ')}\n`);
process.stdout.write(`  rpc:    ${RPC_URL}\n`);
process.stdout.write(`  pool:   ${identityPool.size()} identities\n`);

const shutdown = (signal: string) => {
  process.stderr.write(`\nbridge: ${signal} received, closing\n`);
  server.stop();
  setTimeout(() => process.exit(0), 100).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
