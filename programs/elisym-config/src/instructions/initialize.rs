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
    /// Loader-v3 `ProgramData` for this program, used to require that the
    /// caller is the upgrade authority.
    ///
    /// Without it `initialize` is permissionless first-come: the config PDA
    /// uses `init`, so anyone who lands a call between deploy finalization and
    /// ours seizes `admin`/`treasury` permanently, and the only recovery is a
    /// migration upgrade. `seeds::program` pins the account to THIS program id
    /// and `Account<ProgramData>` enforces the loader as its owner, so another
    /// program's `ProgramData` cannot satisfy the check.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ ErrorCode::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
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
