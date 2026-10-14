use crate::{errors::ErrorCode, events::EvmTreasuryUpdated, instructions::common::AdminOnly};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<AdminOnly>, new_evm_treasury: [u8; 20]) -> Result<()> {
    require!(
        new_evm_treasury != [0u8; 20],
        ErrorCode::InvalidTreasury
    );

    let cfg = &mut ctx.accounts.config;
    let old = cfg.evm_treasury;
    let now = Clock::get()?.unix_timestamp;

    cfg.evm_treasury = new_evm_treasury;
    cfg.last_updated = now;

    emit_cpi!(EvmTreasuryUpdated {
        old_evm_treasury: old,
        new_evm_treasury,
        timestamp: now,
    });
    Ok(())
}
