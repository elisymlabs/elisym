#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE");

#[program]
pub mod elisym_config {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, admin, treasury, fee_bps)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin::handler(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handler(ctx)
    }

    pub fn cancel_pending_admin(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::cancel_pending_admin::handler(ctx)
    }

    pub fn set_fee_bps(ctx: Context<AdminOnly>, new_bps: u16) -> Result<()> {
        instructions::set_fee_bps::handler(ctx, new_bps)
    }

    pub fn set_treasury(ctx: Context<AdminOnly>, new_treasury: Pubkey) -> Result<()> {
        instructions::set_treasury::handler(ctx, new_treasury)
    }
}
