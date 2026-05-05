# @elisym/perf

Local capacity tests for the elisym stack. Answers four scaling questions:

1. **Q1** How many agents can stay online before discovery degrades?
2. **Q2** How fast does an end user see search results in the web app?
3. **Q3** How fast is `discover_agents` in MCP?
4. **Q4** How many concurrent jobs does one provider hold?

Plus a fifth bonus scenario `e2e_steady_state` that runs all of them simultaneously to surface drift / leaks.

This package is **private** (`"private": true`). It is not published, not part of `bun qa`, and runs only on a developer machine.

## Prerequisites

- Docker + docker compose v2 (strfry + prometheus + grafana stack)
- Bun 1.3.11+ (already required by the monorepo)
- `k6` binary on PATH - macOS: `brew install k6`. Linux: see https://grafana.com/docs/k6/latest/set-up/install-k6/.
- For Q4 + Q5 only: a built `@elisym/cli` (`bun run build --filter=@elisym/cli`) and an elisym agent created via `elisym init`.
- For Q3 only: a built `@elisym/mcp` and the same agent.
- Solana CLI on PATH if you plan to run scenarios that exercise on-chain payments (Phase 7+, currently optional).

## Layout

```
docker/                docker compose stack: strfry, prometheus, grafana
bridge/                bun + hono HTTP wrapper around @elisym/sdk
mcp-runner/            (deferred; mcp driver lives inside bridge/)
k6/lib/                shared k6 helpers (env, nostr ws, solana-rpc, stats)
k6/scenarios/          one file per scenario; named after the question it answers
k6/fixtures/           gitignored; pre-signed event fixtures generated on demand
k6/reports/            gitignored; per-run JSON + HTML output
scripts/               stack-up / stack-down / run / start-validator wrappers
skills/perf-translate/ sample SKILL.md to copy into your perf agent
```

## Scenarios at a glance

| Scenario                 | Question        | Pre-conditions                                          |
| ------------------------ | --------------- | ------------------------------------------------------- |
| `relay_publish`          | infra baseline  | stack up                                                |
| `solana_rpc_burst`       | RPC baseline    | stack up + `solana-test-validator` running              |
| `protocol_config_cache`  | RPC + SDK cache | stack + validator + bridge                              |
| `discover_via_bridge`    | sanity smoke    | stack + bridge                                          |
| `agent_fleet_scale`      | Q1              | stack + bridge                                          |
| `relay_subscribe_fanout` | Q2 diagnosis    | stack                                                   |
| `web_discovery_latency`  | Q2              | stack + bridge + a fleet (or run agent_fleet_scale)     |
| `mcp_discovery_latency`  | Q3              | stack + bridge + elisym-mcp on PATH + agent             |
| `provider_saturation`    | Q4              | stack + bridge + provider on host with `--metrics-port` |
| `e2e_steady_state`       | Q5 composite    | everything above                                        |

## Quick start (Q1 fleet sweep, mock-everything)

Three terminals:

```bash
# Terminal 1: infra stack
bun run perf:up

# Terminal 2: bridge
RELAYS=ws://localhost:7777 bun run perf:bridge

# Terminal 3: scenario
bun run perf:run agent_fleet_scale
open http://localhost:3000   # grafana, dashboard "elisym - relay & discovery"
```

Stop when done:

```bash
# Ctrl+C terminal 2
bun run perf:down
```

## Full walk-through to answer all four questions

Each step assumes you completed the previous ones unless marked optional. Numbers come out of Grafana dashboards and the per-run summary in `k6/reports/`.

### 1. Boot the infra stack

```bash
bun run perf:up
```

Brings up:

- `strfry` on `ws://localhost:7777` (local Nostr relay, tuned for high fanout)
- `prometheus` on `http://localhost:9090` (scrapes itself + provider on `host.docker.internal:9464` + bridge on `host.docker.internal:3030`)
- `grafana` on `http://localhost:3000` (anonymous viewer; admin/admin for editing)

### 2. Run the bridge

```bash
RELAYS=ws://localhost:7777 bun run perf:bridge
```

Bridge exposes:

- `GET  /healthz`, `GET /metrics` (prom-client)
- `POST /discover`, `POST /stream-discover`, `POST /protocol-config`
- `POST /fleet/resize`, `POST /fleet/stop`, `GET /fleet/info`
- `POST /job/submit`
- `POST /mcp/start`, `POST /mcp/call`, `POST /mcp/stop`, `GET /mcp/info`

If you want the bridge to talk to a non-local relay (devnet smoke), unset `RELAYS` to use the SDK defaults (relay.damus.io, nos.lol, etc).

### 3. Run the relay baseline

```bash
bun run perf:run relay_publish
```

The first invocation auto-generates a fixture of 5000 pre-signed kind:5100 events via `scripts/generate-events.ts` (writes to `k6/fixtures/events-5100.json`). Subsequent runs reuse it; delete the file to regenerate.

Read off `relay_ok_latency_ms` p95/p99 in the run summary. This is the floor; nothing else can be faster than this on the same box.

### 4. (Optional) Solana baselines

Boot `solana-test-validator` (separate terminal):

```bash
bun run program:build           # produces target/deploy/elisym_config.so
bun run perf:validator          # starts test-validator with the program loaded
```

Then:

```bash
bun run perf:run solana_rpc_burst
bun run perf:run protocol_config_cache
```

Skip these for Q1 / Q2 / Q3 / Q4 - they are foundation runs, not headline.

### 5. Q1: agent fleet scale

```bash
bun run perf:run agent_fleet_scale
```

Sweep is `0 -> 10 -> 100 -> 500 -> 1000 -> 2500 -> 5000` synthetic agents. At each step, 10 discovery samples are taken. Read the curve in Grafana dashboard **elisym - relay & discovery**.

The "knee" is the fleet size at which `discover_call_ms{quantile="0.95"}` jumps. That number tells you how many online agents your local stack can carry before discovery latency degrades.

Tweak via env: `FLEET_SIZES=0,500,5000 SAMPLES=20 PROPAGATION_S=10`.

### 6. Q2: web discovery latency

Pre-condition: a fleet exists (run `agent_fleet_scale` first, or POST to `/fleet/resize` manually).

```bash
# manual fleet bootstrap if needed
curl -X POST localhost:3030/fleet/resize -H 'content-type: application/json' \
  -d '{"size": 500}'

bun run perf:run web_discovery_latency
```

Reads off:

- `ttf_first_card_ms` - time-to-first-card
- `ttn_n_cards_ms` - time-to-N-cards (default N=10)
- `tte_eose_ms` - time-to-EOSE
- `ttc_complete_ms` - time-to-complete (after enrichment)

Diagnose with `relay_subscribe_fanout` if numbers look unexpectedly high.

### 7. Q3: MCP discovery latency

Pre-conditions:

- `@elisym/mcp` built (`bun run build --filter=@elisym/mcp`) and `elisym-mcp` on PATH (link with `bun link`, or use absolute path via `MCP_COMMAND`).
- An elisym agent created: `elisym init perf-agent --local` (run from inside the monorepo for `--local`).

```bash
MCP_AGENT=perf-agent bun run perf:run mcp_discovery_latency
```

Sweeps `0 -> 50 -> 500 -> 2000` agents on the relay. Records `mcp_call_ms` p50/p95/p99 per fleet size. This is the latency a Claude / Cursor / Windsurf user sees on `discover_agents`.

### 8. Q4: provider saturation

Pre-conditions:

- Same `perf-agent` from Q3.
- Copy the sample skill into the agent: `cp -r packages/perf/skills/perf-translate ~/.elisym/perf-agent/skills/` (or your project-local `.elisym/perf-agent/skills/`).
- Edit `~/.elisym/perf-agent/elisym.yaml` to set `relays: [ws://localhost:7777]` so the provider talks to local strfry, not public.
- Provider running on host with mock LLM and metrics enabled:

```bash
MOCK_LLM=1 MOCK_LLM_JITTER_MS=200 \
  elisym start perf-agent --metrics-port 9464
```

Then:

```bash
bun run perf:run provider_saturation
```

Submission RPS ramps `1 -> 5 -> 15 -> 30 -> 60` per second across stages. Open Grafana dashboard **elisym - provider saturation** and watch:

- `elisym_jobs_in_flight` pegging at 10 (= `MAX_CONCURRENT_JOBS`)
- `elisym_jobs_pending` climbing once you exceed sustainable throughput
- `histogram_quantile(0.95, sum(rate(elisym_job_duration_seconds_bucket[1m])))` p95 inflection

The first stage where `pending` climbs without bound is the provider's roof on this hardware with mock LLM. Real LLM is bound by Anthropic / OpenAI rate limits; rerun with `MOCK_LLM` unset and a paid API key to find that ceiling - **expect to burn credits**.

### 9. Q5: composite steady-state

```bash
bun run perf:run e2e_steady_state
```

Holds 500 agents online + 5 discovery RPS + 1 job/min for 10 min. Open dashboard **elisym - end-to-end steady state**. Watch for: success-rate drift > 5%, monotonically growing latency, leaking `jobs_pending`.

Tunables: `SUSTAINED_AGENTS`, `DISCOVERY_RPS`, `JOB_RPS`, `DURATION_MIN`.

## Grafana dashboards

Auto-provisioned in Grafana under folder `elisym-perf`:

| File            | Story                                                       |
| --------------- | ----------------------------------------------------------- |
| `k6.json`       | Cross-scenario overview (VUs, RPS, p50/p95/p99, errors).    |
| `relay.json`    | Q1 - discovery latency vs fleet size.                       |
| `provider.json` | Q4 - jobs in flight, throughput, job duration, health gate. |
| `e2e.json`      | Q5 - composite throughput + drift in success rates.         |

The reports directory (`k6/reports/`) holds per-run JSON + a static HTML summary that mirrors the k6 `textSummary` output.

## Observed numbers

Filled in as runs land. Format: hardware + scenario + headline metric. Re-record after major SDK changes.

```
2026-XX-XX  M1 Pro 32GB  agent_fleet_scale  knee at fleet=____ (p95 jumps from ____ms to ____ms)
2026-XX-XX  M1 Pro 32GB  web_discovery_latency  ttf p95=____ms ttn(10) p95=____ms ttc p95=____ms (fleet=500)
2026-XX-XX  M1 Pro 32GB  mcp_discovery_latency  mcp_call p95=____ms (fleet=500)
2026-XX-XX  M1 Pro 32GB  provider_saturation  sustained ____ jobs/sec (mock LLM, jitter=200ms)
```

## Troubleshooting

- **`k6: command not found`** - install via `brew install k6` (macOS) or download from grafana.com.
- **strfry container exits immediately** - `docker compose -f packages/perf/docker/docker-compose.yml logs strfry`. Usually a `strfry.conf` typo.
- **Grafana shows no provider/bridge data** - those are scraped from `host.docker.internal:9464` and `:3030`. On Linux you may need to add `extra_hosts: ["host.docker.internal:host-gateway"]` to the docker-compose services that need to reach the host (Docker Desktop maps it automatically on macOS).
- **`/job/submit` fails with rate-limit** - the bridge identity pool defaults to 128 keys; if you exceed 20 jobs per identity in a 10-min window the provider's per-customer limiter rejects. Increase via `IDENTITY_POOL_SIZE=512 bun run perf:bridge`.
- **`provider_saturation` shows zero on the dashboards** - confirm provider is reading from local strfry: `relays: [ws://localhost:7777]` in the agent's elisym.yaml. Confirm `--metrics-port 9464` is actually bound.
- **`mcp_discovery_latency` `mcp/start failed`** - the bridge spawns `elisym-mcp` from `PATH`. If you have a workspace build but no global symlink, set `MCP_COMMAND=/absolute/path/to/dist/index.js` (and ensure it has executable bits).
- **fixture rejected by relay** - regenerate via `bun packages/perf/scripts/generate-events.ts --kind 5100 --count 5000`. The fixture commits a future-skewed `created_at` policy; if your strfry rejects, check `rejectEventsNewerThanSeconds` in `strfry.conf`.

## Deferred / future work

- **`payment_full_flow`** end-to-end on test-validator: needs funded keypairs and the elisym-config program deployed; covered by `program:build` + `perf:validator` plumbing already in place.
- **Browser-side warm-cache scenario** (`web_browser_smoke.js`): k6 browser against `vite preview` of `packages/app`. Optional, only meaningful if measuring real IndexedDB cache hits matters to you.
- **Provider recovery scenario** (`provider_recovery.js`): kill -9 the provider mid-run, verify ledger replays paid-but-not-delivered jobs.
- **Real LLM ceiling** (`llm_real.js`): rerun `provider_saturation` without `MOCK_LLM` to find the Anthropic / OpenAI rate-limit ceiling. Costs real money - run intentionally.
