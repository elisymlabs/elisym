use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const STATS_SEED: &[u8] = b"network_stats";
pub const ASSET_STATS_SEED: &[u8] = b"asset_stats";
pub const MAX_FEE_BPS: u16 = 1_000;
pub const CURRENT_VERSION: u8 = 1;
pub const CURRENT_STATS_VERSION: u8 = 1;
pub const CURRENT_ASSET_STATS_VERSION: u8 = 1;

/// Mint key used for native SOL in `AssetStats` PDAs. The all-zero pubkey is
/// the System Program's address and can never be a token mint.
pub const NATIVE_ASSET_SENTINEL: Pubkey = Pubkey::new_from_array([0u8; 32]);

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    /// Reserved kill-switch flag, inert today: `initialize` writes `false` and
    /// no instruction can flip it, so a reader must never take `false` here as
    /// evidence that the protocol is live. Wiring it up needs an admin-gated
    /// `set_paused` plus client-side enforcement - the payment flow runs
    /// outside this program, so the flag can only ever be advisory.
    pub paused: bool,
    pub last_updated: i64,
    pub _reserved: [u8; 128],
}

/// Network-wide payment counter and volume aggregator.
///
/// Best-effort counter: clients append `increment_stats` alongside each
/// payment transaction, so a single `getAccountInfo(stats_pda)` returns
/// running totals without per-tx scans. The instruction has no authorization
/// check today, so a malicious caller can inflate the counter cheaply -
/// authoritative, transfer-bound volume tracking will land with the escrow
/// rewrite that moves the payment flow inside the program.
///
/// Volume slots are fixed for the assets the protocol currently transacts
/// in (native SOL + USDC). Adding new assets requires a program upgrade.
#[account]
#[derive(InitSpace)]
pub struct NetworkStats {
    pub version: u8,
    pub bump: u8,
    pub job_count: u64,
    pub volume_native: u128,
    pub volume_usdc: u128,
    pub last_updated: i64,
    pub _reserved: [u8; 128],
}

/// Per-mint payment counter and volume aggregator (native SOL uses
/// `NATIVE_ASSET_SENTINEL` as the mint key).
///
/// Same best-effort trust model as `NetworkStats`: incremented by clients
/// alongside each payment via `increment_stats_v2`, unauthenticated, so totals
/// can be inflated cheaply. Unlike the fixed `NetworkStats` volume slots, a
/// PDA per mint means new payment assets are counted automatically - no
/// program upgrade per token. `increment_stats_v2` self-registers an unknown
/// mint on first use (`init_if_needed`, payer funds rent); `create_asset_stats`
/// pre-creates a PDA so ordinary payers never hit the rent path. A spammer can
/// create PDAs for arbitrary fake mints, but pays their rent and readers only
/// query known mints.
#[account]
#[derive(InitSpace)]
pub struct AssetStats {
    pub version: u8,
    pub bump: u8,
    /// Token mint, or `NATIVE_ASSET_SENTINEL` for native SOL.
    pub mint: Pubkey,
    pub job_count: u64,
    pub volume: u128,
    pub last_updated: i64,
    pub _reserved: [u8; 64],
}
