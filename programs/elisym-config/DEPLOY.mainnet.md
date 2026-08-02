# elisym-config mainnet deploy runbook

Launch sequence per `docs/plans/solana-mainnet.md` Phase 0 (D4/D5 as amended in review round 16: launch custody = deployer hot key, Squads migration deferred to post-launch). Same program address as devnet: `BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE`.

## Prerequisites

- **Back up `target/deploy/elisym_config-keypair.json` first.** Losing it before the deploy loses the address; after the deploy it has no further security value (the upgrade authority is what matters).
- A funded deployer key at `~/.config/solana/id.json`: deploy rent for the ~226 KB binary (roughly 3.2 SOL for the programdata account) + config/stats rent + fees. The deployer becomes `admin`, `treasury`, and keeps the upgrade authority until the Squads migration.
- A reliable RPC endpoint. The public `api.mainnet-beta.solana.com` routinely rate-limits the hundreds of buffer-write transactions a deploy sends; any free dedicated endpoint is fine here (the public-endpoints-at-launch decision binds client runtime, not one-off ops tooling).
- Fresh build: `bun run program:build` (verify the binary hash matches what was reviewed).

## Sequence (back-to-back - the initialize gap is front-runnable)

`initialize` is permissionless first-come: anyone calling it between deploy finalization and ours seizes admin/treasury on the config PDA. Run steps 1-3 in one sitting, seconds apart.

```bash
# 1. Deploy. If the public endpoint 429s the buffer writes, bypass the npm script
#    and pass a dedicated RPC URL directly: anchor deploy --provider.cluster <url>
bun run program:deploy:mainnet

# 2. Initialize config: fee 0, admin/treasury = deployer (round-16 decision)
DEPLOYER=$(solana-keygen pubkey ~/.config/solana/id.json)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
INITIAL_TREASURY=$DEPLOYER \
INITIAL_FEE_BPS=0 \
  bun run packages/config-client/scripts/initialize.ts

# 3. Initialize stats (signed by admin = deployer). REQUIRED before any SDK release:
#    every payment transaction bundles increment_stats - a missing stats PDA
#    fails all mainnet payments wholesale.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  bun run packages/config-client/scripts/initialize-stats.ts

# 4. Verify immediately (front-run check): admin and treasury must equal $DEPLOYER,
#    fee must be 0, and the NetworkStats PDA must exist.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  bun run packages/config-client/scripts/admin.ts show
```

**Hard gate:** the SDK's `PROTOCOL_PROGRAM_ID_MAINNET` flip must not be released until step 4 confirms the expected admin/treasury AND the stats PDA. If the config was front-run: the upgrade authority can ship a migration upgrade - a delay, not a crisis.

## If a deploy attempt aborts mid-way

Rate-limited buffer writes strand rent-locked SOL in a buffer account. Recover it:

```bash
solana program show --buffers -um
solana program close --buffers -um
```

(`-um` pins mainnet - without it both commands target the solana CLI's default cluster and silently report "no buffers" while the mainnet rent stays stranded. If the deploy used a dedicated RPC, pass `--url <that-rpc>` instead.)

## Post-launch follow-up (deferred, round 16)

Squads migration: create the multisig, then `set_treasury` to the vault -> two-step `propose_admin`/`accept_admin` (vault CPI-signs the accept) -> transfer the upgrade authority to the vault.
