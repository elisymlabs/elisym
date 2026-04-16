use crate::{errors::ErrorCode, events::FeeUpdated, instructions::common::AdminOnly, state::*};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<AdminOnly>, new_bps: u16) -> Result<()> {
    require!(new_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);

    let cfg = &mut ctx.accounts.config;
    let old = cfg.fee_bps;
    let now = Clock::get()?.unix_timestamp;

    cfg.fee_bps = new_bps;
    cfg.last_updated = now;

    emit_cpi!(FeeUpdated {
        old_bps: old,
        new_bps,
        timestamp: now,
    });
    Ok(())
}
