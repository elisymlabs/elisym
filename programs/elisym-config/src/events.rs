use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct AdminProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AdminAccepted {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AdminPendingCancelled {
    pub admin: Pubkey,
    pub cancelled_pending: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeeUpdated {
    pub old_bps: u16,
    pub new_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct TreasuryUpdated {
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StatsInitialized {
    pub admin: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StatsIncremented {
    pub job_count: u64,
    pub amount: u64,
    pub is_native: bool,
    pub timestamp: i64,
}
