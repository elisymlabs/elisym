use crate::{errors::ErrorCode, events::AdminAccepted, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    pub new_admin: Signer<'info>,
}

pub fn handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    let pending = cfg.pending_admin.ok_or(ErrorCode::NoPendingAdmin)?;
    require_keys_eq!(
        pending,
        ctx.accounts.new_admin.key(),
        ErrorCode::Unauthorized
    );

    let old = cfg.admin;
    let now = Clock::get()?.unix_timestamp;

    cfg.admin = pending;
    cfg.pending_admin = None;
    cfg.last_updated = now;

    emit_cpi!(AdminAccepted {
        old_admin: old,
        new_admin: pending,
        timestamp: now,
    });
    Ok(())
}
