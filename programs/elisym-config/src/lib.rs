#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod state;

pub use events::*;
pub use state::*;

declare_id!("BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE");

#[program]
pub mod elisym_config {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("elisym-config ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
