# elisym-config mainnet deploy runbook

Launch sequence per `docs/plans/solana-mainnet.md` Phase 0 (D4/D5 as amended in review round 16: launch custody = deployer hot key, Squads migration deferred to post-launch). Same program address as devnet: `BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE`.

## Prerequisites

- **Back up `target/deploy/elisym_config-keypair.json` first.** Losing it before the deploy loses the address; after the deploy it has no further security value (the upgrade authority is what matters).
- A funded deployer key at `~/.config/solana/id.json`. The deployer becomes `admin`, `treasury`, and keeps the upgrade authority until the Squads migration. Budget, measured against the current 328,520-byte binary with `solana rent` (solana-cli 3.1.x sizes the programdata account at exactly the program length - it does NOT reserve 2x):

  |                                                                            | SOL    |
  | -------------------------------------------------------------------------- | ------ |
  | programdata rent (328,565 bytes)                                           | 2.2877 |
  | IDL metadata account - step 1a; the 26 KB JSON is stored gzipped (~3.6 KB) | 0.031  |
  | program account                                                            | 0.0011 |
  | `Config` + `NetworkStats` PDAs                                             | 0.0052 |
  | three `AssetStats` PDAs (step 3b)                                          | 0.0056 |
  | write-transaction fees                                                     | ~0.002 |

  About **2.35 SOL**; fund **3 SOL** for the success path. Re-measure with `solana rent $(( $(stat -f%z target/deploy/elisym_config.so) + 45 ))` if the binary has grown since.

  **3 SOL does not fund a second attempt.** The deploy creates its write buffer at the full programdata rent (~2.2876 SOL) up front and only refunds it to you in the final transaction, so an aborted attempt leaves ~0.71 SOL against a retry that needs ~2.2888 again - and a plain re-run allocates a _new_ buffer rather than reusing the stranded one. After any abort, either resume into the existing buffer or close it first; see "If a deploy attempt aborts mid-way".

- A reliable RPC endpoint, **and the tool that can actually route traffic to it.** The public `api.mainnet-beta.solana.com` rate-limits the hundreds of write transactions a deploy sends. Routing them elsewhere needs `--use-rpc`, which exists only on `solana program deploy` - writes go to validator TPUs over QUIC without it, where an unstaked deployer is throttled by stake-weighted QoS. **`anchor deploy` cannot do this**: anchor 1.0.0 deploys natively instead of shelling out to the solana CLI, `--use-rpc` is not in its binary at all, and it silently discards unrecognized arguments after `--` (a bogus flag still exits 0). Step 1 therefore calls the solana CLI directly and uploads the IDL separately.
- Fresh build: `bun run program:build` (verify the binary hash matches what was reviewed).

## Sequence (back-to-back)

`initialize` requires the payer to be the program's **upgrade authority** (checked on-chain against the loader's `ProgramData` account), so the deploy-to-init gap is no longer front-runnable - a bystander calling it first is rejected with `Unauthorized`. Two consequences for this runbook: the deploy and the init must use the **same key** (`~/.config/solana/id.json` for both), and the program must still be **upgradeable** at init time under the upgradeable loader (v3), which is what `solana program deploy` uses - do not pass `--final` or hand the upgrade authority to Squads before step 2. Still run steps 1-3 in one sitting; the reason is now operational tidiness, not a race.

**Read first - deploy vs upgrade (LSM era):** the program source now includes `create_asset_stats` + `increment_stats_v2`, so a fresh deploy from this tree ships them day one and step 3b just works. If mainnet was deployed from an older tree, upgrade BEFORE running the block below (compare `solana program show` size against the new `.so`, then deploy at the same address; solana-cli 3.1.x auto-extends the programdata account, so a manual `solana program extend` is only needed on an older CLI). Either way, **an SDK that emits `increment_stats_v2` must not be released against a mainnet program that lacks it** - every payment would fail; the reverse is safe (the upgraded program keeps the legacy instruction for deployed clients). Step 3b is the detector: if it aborts with `InstructionFallbackNotFound`, the deployed program predates the instruction - upgrade and re-run 3b, and do not release the SDK until step 4 shows the PDAs.

```bash
# 1. Deploy the program with the solana CLI, NOT `anchor deploy`. Anchor 1.0.0
#    deploys natively, has no `--use-rpc`, and drops unknown args after `--`
#    without warning - the routing flags below would be silently ignored.
#    `--use-rpc` sends the ~325 write transactions through <url>; the
#    compute-unit price gets an unstaked deployer past stake-weighted QoS.
#    Re-running this on an already-deployed program upgrades it in place and is
#    safe - but read the abort section first if a previous attempt died.
#    `-k` pins the FEE PAYER; `--upgrade-authority` pins who OWNS the write
#    buffer, and therefore who can find or close it after an abort. They are
#    the same file here on purpose - keep it that way, or the abort section's
#    `-k` stops matching. See the note at the end of that section.
#    Confirm the program keypair still derives the expected address first. A
#    regenerated one deploys at a stranger address, and every later step then
#    targets BrX1CRk... and finds nothing. Read the output before continuing -
#    this is a checkpoint, not a guard that can stop the block for you.
solana-keygen pubkey target/deploy/elisym_config-keypair.json
#    ^ must print BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE. If it does not,
#      STOP: restore the backed-up keypair before spending anything.

solana program deploy \
  --url <url> \
  --use-rpc \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 20 \
  -k ~/.config/solana/id.json \
  --program-id target/deploy/elisym_config-keypair.json \
  --upgrade-authority ~/.config/solana/id.json \
  target/deploy/elisym_config.so

# 1a. Upload the IDL - `solana program deploy` does not. In anchor 1.0 this
#     writes a gzipped copy to the external Program Metadata program
#     (ProgM6JC...), authorized off the loader's upgrade authority - so it must
#     run BEFORE the Squads handoff. Run it from the MONOREPO ROOT: `anchor idl`
#     refuses outside a workspace. It can only run once per program; use
#     `anchor idl upgrade` afterwards. (It is a no-op against localnet, so this
#     one step cannot be rehearsed locally.)
#     `anchor idl init` has a `--priority-fee` knob, deliberately unused: its
#     units are undocumented and unverifiable from the binary, and this is a
#     handful of transactions rather than the ~325 of step 1. If it stalls on
#     congestion, retry rather than guess at a unit.
anchor idl init BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE \
  -f target/idl/elisym_config.json --provider.cluster <url>

# 1b. Confirm what actually landed, BEFORE trying to initialize. `initialize`
#     reads the loader's ProgramData account, so this is also the check that it
#     can run at all: "Authority" must be $DEPLOYER and "ProgramData Address"
#     must be present. If ProgramData is missing the program is not under the
#     upgradeable loader and initialize cannot work at this address.
solana program show BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE \
  --url https://api.mainnet-beta.solana.com

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

**Hard gate:** the SDK's `PROTOCOL_PROGRAM_ID_MAINNET` flip must not be released until step 4 confirms the expected admin/treasury, the `NetworkStats` PDA, AND all three `AssetStats` lines reading `exists`. An `AssetStats` line reading `MISSING` after step 3b means 3b failed - most likely because the deployed program predates `increment_stats_v2` (see the deploy-vs-upgrade note above), which makes the release fatal rather than merely unoptimized. Step-2 failure triage, by the account the error names:

- `Unauthorized` (6000) on `program_data` - the init key is not the upgrade authority: wrong keypair, or the authority was already transferred or revoked. Fix the key; do not work around the check.
- `AccountOwnedByWrongProgram` (3007) or `AccountNotInitialized` (3012) on `program_data` - the program is not deployed under the upgradeable loader (v3), so no `ProgramData` account exists at the derived address. This is what a `solana program-v4 deploy` produces. `initialize` is uncallable at this address until the program is closed and redeployed under v3; step 1b catches it first.

**Accepted residual (env mismatch):** `SOLANA_NETWORK=mainnet` against a devnet RPC creates orphan PDAs and a falsely-green `show` - benign because `increment_stats_v2` is `init_if_needed`; genesis-hash verification is the future hardening if ever wanted.

## If a deploy attempt aborts mid-way

First find out what landed - run step 1b. If `solana program show` reports the program, the deploy itself succeeded and only step 1a (the IDL) is left. Do not re-run step 1 "just in case": it would allocate another full buffer, and with ~0.71 SOL left after a successful deploy it fails outright at buffer creation.

If the program did not land, **do not just re-run step 1** - the interrupted attempt left ~2.2876 SOL locked in a write buffer, and a fresh run allocates another one. With 3 SOL funded that second allocation fails outright with `insufficient funds for spend`. Pick one:

**First: Ctrl-C does not stop a deploy.** `solana program deploy` ignores SIGINT - it keeps writing, and the prompt not returning is not evidence that it died. Terminate it deliberately with `kill -TERM <pid>` (dies in about a second) and **confirm the process is gone before running any command below**. Closing a buffer while its deploy is still writing destroys the buffer out from under it; re-running step 1 alongside it allocates a second 2.29 SOL buffer you cannot afford.

**Resume into the stranded buffer (cheaper - keeps the chunks already written).** Only available if **the CLI itself reported the failure**: it then prints `Recover the intermediate account's ephemeral keypair file with 'solana-keygen recover' and the following N-word seed phrase:` - a **seed phrase, not a path** - and, just below it, the buffer address with a ready-made `solana program close <BUFFER_ADDRESS>`. Copy both before clearing the terminal: the address closes the buffer directly, without depending on the authority filter or on `getProgramAccounts` succeeding against the rate-limited public endpoint. A `kill` prints neither, and the keypair is then unrecoverable: skip to closing by authority.

```bash
solana program show --buffers -k ~/.config/solana/id.json -um   # confirm it and its balance
solana-keygen recover -o /tmp/elisym-deploy-buffer.json prompt://   # paste the phrase
solana program deploy \
  --url <url> \
  --use-rpc \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 20 \
  -k ~/.config/solana/id.json \
  --buffer /tmp/elisym-deploy-buffer.json \
  --program-id target/deploy/elisym_config-keypair.json \
  --upgrade-authority ~/.config/solana/id.json \
  target/deploy/elisym_config.so
```

**Or close it and start over**, which refunds the rent to the deployer first. This path needs only the buffer's authority, not its keypair, so it always works:

```bash
solana program show --buffers -k ~/.config/solana/id.json -um
solana program close --buffers -k ~/.config/solana/id.json -um
```

Two filters decide whether these commands see anything, and both fail the same silent way - an empty table that reads as "nothing stranded" while the rent stays locked:

- `-um` pins mainnet; without it they target the solana CLI's default cluster. If the deploy used a dedicated RPC, pass `--url <that-rpc>` instead.
- `-k` pins the authority they match on. The buffer's authority is step 1's `--upgrade-authority` signer, NOT the fee payer, so leaving `-k` off matches against whatever `solana config get` points at.

## Post-launch follow-up (deferred, round 16)

Squads migration: create the multisig, then `set_treasury` to the vault -> two-step `propose_admin`/`accept_admin` (vault CPI-signs the accept) -> transfer the upgrade authority to the vault.
