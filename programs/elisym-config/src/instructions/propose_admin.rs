use crate::{errors::ErrorCode, events::AdminProposed, instructions::common::AdminOnly};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    require!(new_admin != Pubkey::default(), ErrorCode::InvalidAdmin);
    require!(
        ctx.accounts.config.pending_admin.is_none(),
        ErrorCode::PendingAdminAlreadySet
    );

    let cfg = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let current = cfg.admin;

    cfg.pending_admin = Some(new_admin);
    cfg.last_updated = now;

    emit_cpi!(AdminProposed {
        current_admin: current,
        pending_admin: new_admin,
        timestamp: now,
    });
    Ok(())
}
