use crate::{errors::ErrorCode, events::StatsIncremented, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct IncrementStats<'info> {
    #[account(
        mut,
        seeds = [STATS_SEED],
        bump = stats.bump,
    )]
    pub stats: Account<'info, NetworkStats>,
}

pub fn handler(ctx: Context<IncrementStats>, amount: u64, is_native: bool) -> Result<()> {
    let stats = &mut ctx.accounts.stats;
    let now = Clock::get()?.unix_timestamp;

    stats.job_count = stats
        .job_count
        .checked_add(1)
        .ok_or(ErrorCode::StatsOverflow)?;

    let amount_u128 = amount as u128;
    if is_native {
        stats.volume_native = stats
            .volume_native
            .checked_add(amount_u128)
            .ok_or(ErrorCode::StatsOverflow)?;
    } else {
        stats.volume_usdc = stats
            .volume_usdc
            .checked_add(amount_u128)
            .ok_or(ErrorCode::StatsOverflow)?;
    }

    stats.last_updated = now;

    emit_cpi!(StatsIncremented {
        job_count: stats.job_count,
        amount,
        is_native,
        timestamp: now,
    });
    Ok(())
}
