use crate::{errors::ErrorCode, events::StatsInitialized, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct InitializeStats<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + NetworkStats::INIT_SPACE,
        seeds = [STATS_SEED],
        bump,
    )]
    pub stats: Account<'info, NetworkStats>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeStats>) -> Result<()> {
    let stats = &mut ctx.accounts.stats;
    let now = Clock::get()?.unix_timestamp;

    stats.version = CURRENT_STATS_VERSION;
    stats.bump = ctx.bumps.stats;
    stats.job_count = 0;
    stats.volume_native = 0;
    stats.volume_usdc = 0;
    stats.last_updated = now;
    stats._reserved = [0u8; 128];

    emit_cpi!(StatsInitialized {
        admin: ctx.accounts.admin.key(),
        timestamp: now,
    });
    Ok(())
}
