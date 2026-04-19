# Changelog

All notable changes to `@elisym/plugin-elizaos` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
