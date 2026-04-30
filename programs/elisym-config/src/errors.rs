use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Fee exceeds protocol maximum")]
    FeeTooHigh,
    #[msg("Treasury address cannot be default")]
    InvalidTreasury,
    #[msg("Admin address cannot be default")]
    InvalidAdmin,
    #[msg("No pending admin transfer")]
    NoPendingAdmin,
    #[msg("Pending admin already set")]
    PendingAdminAlreadySet,
    #[msg("Unsupported config version")]
    UnsupportedVersion,
    #[msg("Stats counter overflow")]
    StatsOverflow,
}
