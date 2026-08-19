# elisym-config mainnet deploy runbook

Launch sequence per `docs/plans/solana-mainnet.md` Phase 0 (D4/D5 as amended in review round 16: launch custody = deployer hot key, Squads migration deferred to post-launch). Same program address as devnet: `BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE`.

## Prerequisites

- **Back up `target/deploy/elisym_config-keypair.json` first.** Losing it before the deploy loses the address; after the deploy it has no further security value (the upgrade authority is what matters).
- A funded deployer key at `~/.config/solana/id.json`: deploy rent for the ~226 KB binary (roughly 3.2 SOL for the programdata account) + config/stats rent + fees. The deployer becomes `admin`, `treasury`, and keeps the upgrade authority until the Squads migration.
- A reliable RPC endpoint. The public `api.mainnet-beta.solana.com` routinely rate-limits the hundreds of buffer-write transactions a deploy sends; any free dedicated endpoint is fine here (the public-endpoints-at-launch decision binds client runtime, not one-off ops tooling).
- Fresh build: `bun run program:build` (verify the binary hash matches what was reviewed).

## Sequence (back-to-back)

`initialize` requires the payer to be the program's **upgrade authority** (checked on-chain against the loader's `ProgramData` account), so the deploy-to-init gap is no longer front-runnable - a bystander calling it first is rejected with `Unauthorized`. Two consequences for this runbook: the deploy and the init must use the **same key** (`~/.config/solana/id.json` for both), and the program must still be **upgradeable** at init time under the upgradeable loader (v3), which is what `anchor deploy` uses - do not deploy with `--final` or hand the upgrade authority to Squads before step 2. Still run steps 1-3 in one sitting; the reason is now operational tidiness, not a race.

**Read first - deploy vs upgrade (LSM era):** the program source now includes `create_asset_stats` + `increment_stats_v2`, so a fresh deploy from this tree ships them day one and step 3b just works. If mainnet was deployed from an older tree, upgrade BEFORE running the block below (`solana program show` size vs the new `.so`; `solana program extend` if the programdata account is smaller - the added instructions grow the binary; then deploy at the same address). Either way, **an SDK that emits `increment_stats_v2` must not be released against a mainnet program that lacks it** - every payment would fail; the reverse is safe (the upgraded program keeps the legacy instruction for deployed clients). Step 3b is the detector: if it aborts with `InstructionFallbackNotFound`, the deployed program predates the instruction - upgrade and re-run 3b, and do not release the SDK until step 4 shows the PDAs.

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
#    every payment transaction bundles a stats instruction - a missing stats PDA
#    fails all mainnet payments wholesale.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  bun run packages/config-client/scripts/initialize-stats.ts

# 3b. Pre-create the per-mint AssetStats PDAs (sentinel + mainnet USDC + LSM).
#     REQUIRED before releasing the LSM-era SDK (its payments bundle
#     increment_stats_v2): without pre-creation the first payer per asset
#     funds ~0.0019 SOL of PDA rent - functional, but not what we ship.
#     SOLANA_NETWORK is explicit by design (never inferred from the RPC URL).
SOLANA_NETWORK=mainnet \
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  bun run packages/config-client/scripts/create-asset-stats.ts

# 4. Verify immediately: admin and treasury must equal $DEPLOYER,
#    fee must be 0, the NetworkStats PDA must exist, and the three AssetStats
#    PDAs must show as existing.
SOLANA_NETWORK=mainnet \
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  bun run packages/config-client/scripts/admin.ts show
```

**Hard gate:** the SDK's `PROTOCOL_PROGRAM_ID_MAINNET` flip must not be released until step 4 confirms the expected admin/treasury, the `NetworkStats` PDA, AND all three `AssetStats` lines reading `exists`. An `AssetStats` line reading `MISSING` after step 3b means 3b failed - most likely because the deployed program predates `increment_stats_v2` (see the deploy-vs-upgrade note above), which makes the release fatal rather than merely unoptimized. If step 2 fails with `Unauthorized`, the init key is not the upgrade authority (wrong keypair, or the authority was already transferred/revoked) - fix the key, do not work around the check.

**Accepted residual (env mismatch):** `SOLANA_NETWORK=mainnet` against a devnet RPC creates orphan PDAs and a falsely-green `show` - benign because `increment_stats_v2` is `init_if_needed`; genesis-hash verification is the future hardening if ever wanted.

## If a deploy attempt aborts mid-way

Rate-limited buffer writes strand rent-locked SOL in a buffer account. Recover it:

```bash
solana program show --buffers -um
solana program close --buffers -um
```

(`-um` pins mainnet - without it both commands target the solana CLI's default cluster and silently report "no buffers" while the mainnet rent stays stranded. If the deploy used a dedicated RPC, pass `--url <that-rpc>` instead.)

## Post-launch follow-up (deferred, round 16)

Squads migration: create the multisig, then `set_treasury` to the vault -> two-step `propose_admin`/`accept_admin` (vault CPI-signs the accept) -> transfer the upgrade authority to the vault.
