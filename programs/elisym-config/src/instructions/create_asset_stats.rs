use crate::{events::AssetStatsCreated, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct CreateAssetStats<'info> {
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

pub fn handler(ctx: Context<CreateAssetStats>, mint: Pubkey) -> Result<()> {
    let asset_stats = &mut ctx.accounts.asset_stats;
    // Idempotent no-op when the PDA already exists (version is only ever
    // written as non-zero); no event on this path.
    if asset_stats.version != 0 {
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;

    asset_stats.version = CURRENT_ASSET_STATS_VERSION;
    asset_stats.bump = ctx.bumps.asset_stats;
    asset_stats.mint = mint;
    asset_stats.job_count = 0;
    asset_stats.volume = 0;
    asset_stats.last_updated = now;
    asset_stats._reserved = [0u8; 64];

    emit_cpi!(AssetStatsCreated {
        mint,
        payer: ctx.accounts.payer.key(),
        timestamp: now,
    });
    Ok(())
}
