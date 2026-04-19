# Changelog

All notable changes to `@elisym/plugin-elizaos` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Targets `@elizaos/core` `~1.7.2` (was `~1.0.0`). Handler return type is now `ActionResult | void | undefined`; all actions return `{ success, data?, text?, error? }` instead of arbitrary objects.

### Added

- Auto-generated Nostr + Solana keys persisted in agent memory when env vars are empty.
- Kind:0 profile publication separating agent bio (NIP-01) from product card description (NIP-89).
- Multi-product support via `ELISYM_PROVIDER_PRODUCTS` (JSON array). Single-product env vars still work as fallback.
- Stale capability-card GC on startup - cards authored by this identity but absent from config are tombstoned.
- 10-minute heartbeat republish of capability cards and NIP 20200/20201 ping responder.
- `examples/local-agent/` sandbox with PGlite-backed `db:inspect` / `db:clear` scripts.
- Initial package scaffold: config schema, spending guard, wallet service, ElisymClient lifecycle, Actions skeleton, Providers skeleton.
