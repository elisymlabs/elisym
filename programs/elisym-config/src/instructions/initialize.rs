use crate::{errors::ErrorCode, events::ConfigInitialized, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    admin: Pubkey,
    treasury: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
    require!(treasury != Pubkey::default(), ErrorCode::InvalidTreasury);
    require!(admin != Pubkey::default(), ErrorCode::InvalidAdmin);

    let cfg = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    cfg.version = CURRENT_VERSION;
    cfg.bump = ctx.bumps.config;
    cfg.admin = admin;
    cfg.pending_admin = None;
    cfg.treasury = treasury;
    cfg.fee_bps = fee_bps;
    cfg.paused = false;
    cfg.last_updated = now;
    cfg._reserved = [0u8; 128];

    emit_cpi!(ConfigInitialized {
        admin,
        treasury,
        fee_bps,
        timestamp: now,
    });
    Ok(())
}
