use crate::{errors::ErrorCode, events::AdminPendingCancelled, instructions::common::AdminOnly};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<AdminOnly>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    let cancelled = cfg.pending_admin.ok_or(ErrorCode::NoPendingAdmin)?;
    let now = Clock::get()?.unix_timestamp;

    cfg.pending_admin = None;
    cfg.last_updated = now;

    emit_cpi!(AdminPendingCancelled {
        admin: cfg.admin,
        cancelled_pending: cancelled,
        timestamp: now,
    });
    Ok(())
}
