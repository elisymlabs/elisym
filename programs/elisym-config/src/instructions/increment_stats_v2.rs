use crate::{errors::ErrorCode, events::StatsIncrementedV2, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(amount: u64, mint: Pubkey)]
pub struct IncrementStatsV2<'info> {
    #[account(
        mut,
        seeds = [STATS_SEED],
        bump = stats.bump,
    )]
    pub stats: Account<'info, NetworkStats>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AssetStats::INIT_SPACE,
        seeds = [ASSET_STATS_SEED, mint.as_ref()],
        bump,
    )]
    pub asset_stats: Account<'info, AssetStats>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<IncrementStatsV2>, amount: u64, mint: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Self-register a brand-new mint: `init_if_needed` zero-initializes fresh
    // account data, so `version == 0` reliably means "just created" and the
    // identity fields must be written exactly as `create_asset_stats` does.
    let asset_stats = &mut ctx.accounts.asset_stats;
    if asset_stats.version == 0 {
        asset_stats.version = CURRENT_ASSET_STATS_VERSION;
        asset_stats.bump = ctx.bumps.asset_stats;
        asset_stats.mint = mint;
        asset_stats._reserved = [0u8; 64];
    }
    asset_stats.job_count = asset_stats
        .job_count
        .checked_add(1)
        .ok_or(ErrorCode::StatsOverflow)?;
    asset_stats.volume = asset_stats
        .volume
        .checked_add(amount as u128)
        .ok_or(ErrorCode::StatsOverflow)?;
    asset_stats.last_updated = now;

    // The global job counter stays continuous across legacy and v2 clients;
    // volume lives only in the per-mint PDA on this path.
    let stats = &mut ctx.accounts.stats;
    stats.job_count = stats
        .job_count
        .checked_add(1)
        .ok_or(ErrorCode::StatsOverflow)?;
    stats.last_updated = now;

    emit_cpi!(StatsIncrementedV2 {
        mint,
        amount,
        asset_job_count: asset_stats.job_count,
        network_job_count: stats.job_count,
        timestamp: now,
    });
    Ok(())
}
