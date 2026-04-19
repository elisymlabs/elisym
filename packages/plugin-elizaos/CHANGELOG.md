# Changelog

All notable changes to `@elisym/plugin-elizaos` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - Unreleased

### Security

- **Pluggable Signer seam.** `ELISYM_SIGNER_KIND` selects `local` (default), `kms`, or `external`. With `kms` / `external`, the plugin refuses to load a plaintext private key. SDK exposes `Signer` (an alias of `@solana/kit` `TransactionSigner`) so adapters can plug into `PaymentStrategy.buildTransaction` without the SDK needing to know about the vendor.
- **SECRET_SALT + ELIZA_SERVER_AUTH_TOKEN required on mainnet / provider-with-key.** Plugin init refuses to start if either is missing or set to a known placeholder. `ELISYM_ALLOW_UNSECURED_RUNTIME=true` downgrades to a one-shot WARN for local dev only.
- **Tighter paymentRequest schema.** SDK Zod-validates incoming payment requests at parse time (negative / float / NaN / Infinity / oversized amount; non-base58 recipient/reference; out-of-range expiry). Plugin passes the customer's `maxPriceLamports` cap so an attacker-crafted request is rejected before any RPC round-trip.
- **Per-customer rate limit.** Sliding-window `RateLimiter` (default 20 jobs / 60s, LRU-bounded at 1000 tracked customers) gates `handleIncomingJob` before any LLM / RPC work runs. Overflow gets an immediate "Rate limit exceeded" error feedback.
- **Log scrubbing for PII.** Pino's `redact.paths` now also covers `content` / `input` / `prompt` (and the nested `*.content`, `event.content` shapes). Distinct `[INPUT REDACTED]` censor for customer-confidential text vs `[REDACTED]` for secrets.

### Reliability

- **Mainnet-ready transaction submission.** Every payment tx now sets an explicit `ComputeBudget.setComputeUnitLimit` (default 200 000) and `setComputeUnitPrice` (default 75th-percentile of recent prioritization fees, cached 10 s, 1000-microLamport floor). Callers can override via `BuildTransactionOptions`.
- **Discovery cache TTL.** `lastDiscovery` expires after 5 minutes; `ELISYM_HIRE_AGENT.validate` returns false past the TTL and the handler throws a clear "discovery is stale, re-run DISCOVER" error.
- **`activeJobs` map cap + TTL.** `jobCompletionEvaluator` evicts non-terminal jobs whose `lastUpdate` is older than 1 hour; `hireAgent` caps the map at 200 entries and evicts the oldest by `lastUpdate` before inserting.
- **Graceful shutdown wiring.** `Plugin.init` exposes a `shuttingDown` state flag and registers `SIGTERM` / `SIGINT` hooks (covered by integration tests).

### Observability

- **`/plugins/elisym/health` HTTP route.** Returns mode/network, agent npub + Solana address, active job count, hourly spend / cap, shutdown flag. 503 if state is not yet initialised.
- **`/plugins/elisym/metrics` Prometheus endpoint.** Counters: `elisym_jobs_total{side,state}`, `elisym_rpc_errors_total`, `elisym_relay_pool_reset_total`. Histograms: `elisym_payment_latency_seconds`, `elisym_ping_pong_roundtrip_ms`. The jobs counter is bumped automatically inside `recordTransition` so every state transition is captured.
- **Integration tests for crash recovery.** Six scenario files covering provider crashes after `paid` / `executed`, customer crashes after `submitted` / `payment_sent`, the recovery concurrency ceiling, and graceful shutdown wiring.

### Added

- `ELISYM_CLEANUP_JOBS` operator action: force-runs `pruneOldEntries` from chat or HTTP. Restricted to provider/both modes.

### Changed

- `@elisym/sdk` bumped to `~0.6.0` (additive: `Signer`, `BuildTransactionOptions`, `estimatePriorityFeeMicroLamports`, `parsePaymentRequest`, `PaymentRequestSchema` exports). No removals.

### Deprecated

- `ELISYM_PROVIDER_CAPABILITIES`, `ELISYM_PROVIDER_PRICE_SOL`, `ELISYM_PROVIDER_NAME`, `ELISYM_PROVIDER_DESCRIPTION` are slated for removal in 0.4.0. Setting both these and `ELISYM_PROVIDER_PRODUCTS` now throws; legacy-only configurations emit a one-shot WARN and continue to work.

## [0.2.0] - Unreleased

### Reliability

- **Crash recovery via `JobLedger`.** Every provider / customer state transition (`waiting_payment`, `paid`, `executed`, `delivered`, `submitted`, `payment_sent`, `result_received`, `failed`) is persisted to the `elisym_jobs` memory table. A new `RecoveryService` sweeps pending entries on startup and every 2 minutes, re-verifying payments, re-executing jobs, and re-delivering results. Retry budget: 5 attempts per entry, bounded by 4-way concurrency.
- **Spending cap persists across restarts.** Each confirmed `recordSpend` writes to the `elisym_spend` memory table; `WalletService.initialize` replays the last hour so `ELISYM_MAX_SPEND_PER_HOUR_SOL` survives a crash loop.
- **Concurrency guard on incoming jobs.** `ProviderService` wraps `subscribeToJobRequests` in `p-limit(MAX_CONCURRENT_INCOMING_JOBS = 10)` with a queue depth of 40. Overflow events get an explicit "overloaded" error feedback instead of exhausting LLM quota or RPC rate.
- **Graceful shutdown on `SIGTERM` / `SIGINT`.** Plugin init registers a process-level hook that marks state `shuttingDown` and stops services in reverse dependency order with a 10-second per-step timeout. `handleIncomingJob` drops new jobs while drain is in progress so the customer retries later instead of paying for a guaranteed-crash job.

### Changed

- Targets `@elizaos/core` `~1.7.2` (was `~1.0.0`). Handler return type is now `ActionResult | void | undefined`; all actions return `{ success, data?, text?, error? }` instead of arbitrary objects.
- `recordTransition` now always stamps fresh `transitionAt` and `version`; ledger ordering uses `memory.createdAt` (DB-level timestamp) instead of the denormalized entry field.

### Added

- Auto-generated Nostr + Solana keys persisted in agent memory when env vars are empty.
- Kind:0 profile publication separating agent bio (NIP-01) from product card description (NIP-89).
- Multi-product support via `ELISYM_PROVIDER_PRODUCTS` (JSON array). Single-product env vars still work as fallback.
- Stale capability-card GC on startup - cards authored by this identity but absent from config are tombstoned.
- 10-minute heartbeat republish of capability cards and NIP 20200/20201 ping responder.
- `examples/local-agent/` sandbox with PGlite-backed `db:inspect` / `db:clear` scripts.
- Initial package scaffold: config schema, spending guard, wallet service, ElisymClient lifecycle, Actions skeleton, Providers skeleton.
