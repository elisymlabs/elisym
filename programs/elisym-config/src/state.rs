use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const STATS_SEED: &[u8] = b"network_stats";
pub const MAX_FEE_BPS: u16 = 1_000;
pub const CURRENT_VERSION: u8 = 1;
pub const CURRENT_STATS_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub treasury: Pubkey,
    pub fee_bps: u16,
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
