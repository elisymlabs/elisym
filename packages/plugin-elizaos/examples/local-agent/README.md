# Local-agent sandbox

Runs a real ElizaOS v1 agent that loads `@elisym/plugin-elizaos` straight from this monorepo via `file:../..`. No publishing required.

Three character files are provided:

- `customer.character.json` - hires providers
- `provider.character.json` - advertises `summarization`
- `both.character.json` - does both (mode=both)

---

## 1. One-time setup

```bash
# in the monorepo root
bun run build --filter=@elisym/plugin-elizaos      # produces dist/ that file: link reads
cd packages/plugin-elizaos/examples/local-agent

cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY (the ElizaOS agent needs its own LLM)

bun install                                        # installs cli + plugins + plugin-elizaos
```

Any time you change source in `packages/plugin-elizaos/src/`, rerun the build from the monorepo root:

```bash
bun run build --filter=@elisym/plugin-elizaos
```

The `link:` dep is a real symlink into `packages/plugin-elizaos`, so the rebuilt `dist/` is picked up on next agent start without touching `bun install`.

---

## 2. Flow A - explicit keys (regression)

Generate a throwaway devnet keypair or use an existing one:

```bash
# Nostr hex (32 bytes)
openssl rand -hex 32
# Solana base58 (64-byte secret) - e.g. via solana-keygen + bs58 conversion,
# or any existing Phantom devnet wallet export
```

Edit `customer.character.json` - paste the keys into `settings.secrets`:

```json
"secrets": {
  "ELISYM_NOSTR_PRIVATE_KEY": "<64 hex chars or nsec1...>",
  "ELISYM_SOLANA_PRIVATE_KEY": "<base58 64-byte secret>"
}
```

Run:

```bash
LOG_LEVEL=debug bun run start:customer
```

Expected logs on first start **and** every subsequent start:

```
info ... ElisymService ready            pubkey=<your pubkey>
info ... WalletService ready            source=config  address=<your address>
```

If you see `source=persisted` or `source=generated` here, the config values are not being read - double-check the character JSON.

---

## 3. Flow B - auto-generate + persist (the new path)

Reset the character: clear both secrets back to empty strings.

```bash
bun run db:clear      # wipe any previous elisym_* memory entries
LOG_LEVEL=debug bun run start:customer
```

First-start expected logs:

```
warn ... generated new elisym identity and persisted it to agent memory   pubkey=...  npub=npub1...
warn ... generated new elisym Solana wallet and persisted it to agent memory   address=<Solana addr>
```

Verify the secrets landed in the agent DB:

```bash
bun run db:inspect
# expected two rows:
#   elisym_identity | <64 hex chars>
#   elisym_wallet   | <long base58>
```

Kill the agent (Ctrl-C) and start it again without touching the character:

```bash
bun run start:customer
```

Second-start expected logs:

```
info ... loaded persisted elisym identity from agent memory
info ... WalletService ready   source=persisted   address=<same addr as first run>
```

The `npub` and Solana `address` must match run-1 exactly. That proves persist+reuse.

### Sanity: clear DB, restart

```bash
bun run db:clear
bun run start:customer
```

Agent should log WARN again, with **different** pubkey/address. No crash, no missing-key error.

---

## 4. Fund the auto-generated wallet

Copy the Solana `address` from the WARN log, then:

```bash
solana airdrop 1 <address> --url devnet
```

`ELISYM_CHECK_WALLET` action inside the chat should then report a non-zero balance.

---

## 5. End-to-end hire (optional - needs a live provider)

In shell 1:

```bash
bun run start:provider        # advertises summarization
```

In shell 2 (different terminal, same folder):

```bash
bun run start:customer
```

Chat with the customer agent:

```
> find me an elisym summarization agent
> hire the first one to summarize this article about bees: ...
```

Watch both terminals - customer should publish NIP-90 request, provider logs `incoming job received`, customer signs the SOL transfer, provider logs `payment received, processing job`, then result comes back encrypted.

---

## Troubleshooting

- **`Cannot find module '@elisym/plugin-elizaos'`** - you didn't run `bun run build --filter=@elisym/plugin-elizaos` in the monorepo root. `file:../..` only links the package folder; tsup still has to produce `dist/`.
- **Agent responds but no elisym actions fire** - check the character's `plugins` array includes `@elisym/plugin-elizaos` and `LOG_LEVEL=debug` shows `ElisymService ready`.
- **DB is not SQLite** - `@elizaos/plugin-sql` v1.0.x uses PGlite (postgres-in-wasm). Data lives at `./.eliza/.elizadb/` relative to the agent's working directory. The `db:inspect` / `db:clear` scripts read/write it via `@electric-sql/pglite`. If you ever want a nuclear reset: `rm -rf .eliza/.elizadb`.
- **Peer dependency mismatch** - the plugin is pinned to `@elizaos/core ~1.0.0`. Do not bump cli/plugin-bootstrap past `1.0.x` here, or the loader may refuse to register the plugin.
