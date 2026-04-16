# @elisym/config-client

Codama-generated TypeScript client for the `elisym-config` Solana program. Used internally by `@elisym/sdk` to read on-chain protocol configuration (fee, treasury, admin).

## Admin CLI

Manage the on-chain config from the terminal. All commands default to devnet.

| Command                  | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `show`                   | Display current on-chain config                       |
| `set-fee <bps>`          | Update protocol fee (0-1000 bps)                      |
| `set-treasury <pubkey>`  | Update treasury address                               |
| `propose-admin <pubkey>` | Propose a new admin (step 1 of 2)                     |
| `accept-admin`           | Accept admin role from new admin wallet (step 2 of 2) |
| `cancel-pending-admin`   | Cancel a pending admin transfer                       |

```bash
# Read config (no transaction)
bun run packages/config-client/scripts/admin.ts show

# Update fee to 5%
bun run packages/config-client/scripts/admin.ts set-fee 500

# Transfer admin
bun run packages/config-client/scripts/admin.ts propose-admin <new-admin-pubkey>
KEYPAIR=~/.config/solana/new-admin.json \
  bun run packages/config-client/scripts/admin.ts accept-admin
```

Optional env vars: `PROGRAM_ID`, `RPC_URL`, `KEYPAIR`.

## Initialize (one-shot)

```bash
INITIAL_TREASURY=<treasury-pubkey> \
  bun run packages/config-client/scripts/initialize-devnet.ts
```

## Build

```bash
bun run build --filter=@elisym/config-client
```

The build runs `codama.config.mjs` first to regenerate the client from the Anchor IDL, then bundles with tsup.
