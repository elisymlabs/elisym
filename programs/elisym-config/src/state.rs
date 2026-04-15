use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MAX_FEE_BPS: u16 = 1_000;
pub const CURRENT_VERSION: u8 = 1;

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
