// mcp_discovery_latency.js
//
// Q3: how fast is `discover_agents` in MCP?
//
// Methodology:
//   - One bridge process holds one MCP child (single shared session, like a
//     real assistant client).
//   - For each fleet size in FLEET_SIZES, repeat:
//       1. POST /fleet/resize { size }
//       2. Sleep PROPAGATION_S
//       3. POST /mcp/call { tool: 'discover_agents', args: {...} } x SAMPLES
//   - Records p50/p95/p99 of MCP-tool latency, separately from bridge overhead.
//
// Single VU, sequential by design (stdio is synchronous).
//
// Pre-conditions:
//   - bridge running with MCP_AGENT=<name> (or pass `agent` in /mcp/start body).
//   - elisym-mcp on PATH (built from packages/mcp), or set MCP_COMMAND.
//   - elisym agent <name> exists (run `elisym init <name>` once).

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const SAMPLES = intEnv('SAMPLES', 20);
const PROPAGATION_S = intEnv('PROPAGATION_S', 5);
const NETWORK = __ENV.NETWORK || 'devnet';
const CAPABILITY = __ENV.CAPABILITY || 'translate';
const AGENT_LIMIT = intEnv('AGENT_LIMIT', 50);
const MCP_AGENT = __ENV.MCP_AGENT || '';
const MCP_COMMAND = __ENV.MCP_COMMAND || 'elisym-mcp';
const FLEET_SIZES = (__ENV.FLEET_SIZES || '0,50,500,2000')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n >= 0);

const mcpLatency = new Trend('mcp_call_ms', true);
const mcpToolErrors = new Counter('mcp_tool_errors_total');
const mcpHttpErrors = new Counter('mcp_http_errors_total');
const success = new Rate('mcp_success_rate');

export const options = {
  scenarios: {
    sweep: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  thresholds: {
    mcp_success_rate: ['rate>0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy`);
  }
  const startBody = JSON.stringify({
    agent: MCP_AGENT || undefined,
    command: MCP_COMMAND,
  });
  const startRes = http.post(`${BRIDGE_URL}/mcp/start`, startBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
  if (startRes.status !== 200) {
    throw new Error(`mcp/start failed (${startRes.status}): ${startRes.body}`);
  }
}

export function teardown() {
  http.post(`${BRIDGE_URL}/mcp/stop`, '{}', {
    headers: { 'Content-Type': 'application/json' },
  });
}

function discoverOnce(fleetSize) {
  const body = JSON.stringify({
    tool: 'discover_agents',
    args: { capability: CAPABILITY, limit: AGENT_LIMIT, network: NETWORK },
  });
  const res = http.post(`${BRIDGE_URL}/mcp/call`, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '60s',
  });
  if (res.status !== 200) {
    mcpHttpErrors.add(1, { fleet_size: String(fleetSize) });
    success.add(false);
    return;
  }
  let parsed;
  try {
    parsed = res.json();
  } catch (_err) {
    mcpHttpErrors.add(1, { fleet_size: String(fleetSize) });
    success.add(false);
    return;
  }
  const ok = parsed?.ok === true;
  success.add(ok, { fleet_size: String(fleetSize) });
  if (typeof parsed?.elapsedMs === 'number') {
    mcpLatency.add(parsed.elapsedMs, { fleet_size: String(fleetSize) });
  }
  if (parsed?.isToolError) {
    mcpToolErrors.add(1, { fleet_size: String(fleetSize) });
  }
}

export default function () {
  for (const size of FLEET_SIZES) {
    const t0 = Date.now();
    const resizeRes = http.post(
      `${BRIDGE_URL}/fleet/resize`,
      JSON.stringify({ size, capability: CAPABILITY }),
      { headers: { 'Content-Type': 'application/json' }, timeout: '120s' },
    );
    check(resizeRes, { 'fleet resize 200': (r) => r.status === 200 });
    sleep(PROPAGATION_S);
    for (let i = 0; i < SAMPLES; i++) {
      discoverOnce(size);
    }
    const stepDuration = (Date.now() - t0) / 1000;
    console.log(`[step] fleet=${size} samples=${SAMPLES} step_seconds=${stepDuration.toFixed(1)}`);
  }
  http.post(`${BRIDGE_URL}/fleet/stop`, '{}', {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function handleSummary(data) {
  return writeSummary(data);
}
