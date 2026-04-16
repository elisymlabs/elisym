use crate::{errors::ErrorCode, state::*};
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized,
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}
