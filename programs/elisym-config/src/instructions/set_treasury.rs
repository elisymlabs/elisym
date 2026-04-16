use crate::{errors::ErrorCode, events::TreasuryUpdated, instructions::common::AdminOnly};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<AdminOnly>, new_treasury: Pubkey) -> Result<()> {
    require!(
        new_treasury != Pubkey::default(),
        ErrorCode::InvalidTreasury
    );

    let cfg = &mut ctx.accounts.config;
    let old = cfg.treasury;
    let now = Clock::get()?.unix_timestamp;

    cfg.treasury = new_treasury;
    cfg.last_updated = now;

    emit_cpi!(TreasuryUpdated {
        old_treasury: old,
        new_treasury,
        timestamp: now,
    });
    Ok(())
}
