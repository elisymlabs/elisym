//! Mollusk integration tests for the elisym-config Anchor program.
//!
//! Coverage targets:
//! - 6 happy-path flows (initialize, propose+accept, cancel pending, fee, treasury, rotation+lockout)
//! - 12 negative cases (validation, auth, reinit, missing pending)
//! - Invariant assertions per success: bump match, version pin, last_updated monotonicity,
//!   `_reserved` zeroed.
//!
//! Run via:
//! ```
//! cargo test --package elisym-config --test config -- --test-threads=1
//! ```
//! Single-threaded because the tests share the workspace `target/deploy/elisym_config.so`
//! through the `SBF_OUT_DIR` env var that we set inside `setup_sbf_dir`.

use anchor_lang::{system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use elisym_config::accounts as ix_accounts;
use elisym_config::instruction as ix_args;
use elisym_config::state::{Config, CONFIG_SEED, CURRENT_VERSION, MAX_FEE_BPS};
use elisym_config::ID as PROGRAM_ID;
use mollusk_svm::program;
use mollusk_svm::result::Check;
use mollusk_svm::Mollusk;
use solana_sdk::account::Account;
use solana_sdk::instruction::Instruction;
use solana_sdk::program_error::ProgramError;
use solana_sdk::pubkey::Pubkey;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PAYER_LAMPORTS: u64 = 10_000_000_000;
const ANCHOR_ERROR_OFFSET: u32 = 6000;
const FEE_TOO_HIGH: u32 = ANCHOR_ERROR_OFFSET + 1;
const INVALID_TREASURY: u32 = ANCHOR_ERROR_OFFSET + 2;
const INVALID_ADMIN: u32 = ANCHOR_ERROR_OFFSET + 3;
const NO_PENDING_ADMIN: u32 = ANCHOR_ERROR_OFFSET + 4;
const PENDING_ADMIN_ALREADY_SET: u32 = ANCHOR_ERROR_OFFSET + 5;
// `has_one = admin @ ErrorCode::Unauthorized` and the explicit `require_keys_eq!` in
// accept_admin both surface as our custom Unauthorized (6000), not the generic anchor
// ConstraintHasOne (2001).
const UNAUTHORIZED: u32 = ANCHOR_ERROR_OFFSET; // 6000
const ANCHOR_ACCOUNT_ALREADY_INITIALIZED: u32 = 0; // SystemError::AccountAlreadyInUse

fn setup_sbf_dir() {
    let workspace_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .to_path_buf();
    let sbf_dir = workspace_root.join("target").join("deploy");
    // SAFETY: tests are forced to single-thread execution via --test-threads=1.
    unsafe {
        std::env::set_var("SBF_OUT_DIR", &sbf_dir);
    }
}

fn mollusk_with_program() -> Mollusk {
    setup_sbf_dir();
    let mut mollusk = Mollusk::default();
    mollusk.add_program(&PROGRAM_ID, "elisym_config");
    mollusk
}

fn empty_account() -> Account {
    Account {
        lamports: 0,
        data: vec![],
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn funded_account(lamports: u64) -> Account {
    Account {
        lamports,
        data: vec![],
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID)
}

fn event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &PROGRAM_ID).0
}

fn read_config(account: &Account) -> Config {
    Config::try_deserialize(&mut &account.data[..]).expect("Config deserialize")
}

/// Replace or insert an account in a vec keyed by pubkey.
fn upsert(accounts: &mut Vec<(Pubkey, Account)>, key: Pubkey, value: Account) {
    if let Some(slot) = accounts.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
    } else {
        accounts.push((key, value));
    }
}

/// Pull an account out of a result by key.
fn get_resulting(
    result: &mollusk_svm::result::InstructionResult,
    key: Pubkey,
) -> Account {
    result
        .resulting_accounts
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, a)| a.clone())
        .unwrap_or_else(|| panic!("missing account in result: {key}"))
}

/// Assert the persistent invariants expected on every successful state mutation.
fn assert_post_mutation_invariants(cfg: &Config, prev_last_updated: i64) {
    let (_, expected_bump) = config_pda();
    assert_eq!(cfg.bump, expected_bump, "bump must match canonical PDA bump");
    assert_eq!(
        cfg.version, CURRENT_VERSION,
        "version must remain pinned to {CURRENT_VERSION}"
    );
    assert!(
        cfg.last_updated >= prev_last_updated,
        "last_updated must be monotonic: prev={prev_last_updated} new={}",
        cfg.last_updated
    );
    assert_eq!(
        cfg._reserved,
        [0u8; 128],
        "_reserved must remain zeroed for forward-compat schema migration"
    );
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

fn build_initialize_ix(payer: Pubkey, admin: Pubkey, treasury: Pubkey, fee_bps: u16) -> Instruction {
    let (config, _) = config_pda();
    let metas = ix_accounts::Initialize {
        config,
        payer,
        system_program: system_program::ID,
        event_authority: event_authority_pda(),
        program: PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ix_args::Initialize {
        admin,
        treasury,
        fee_bps,
    }
    .data();
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas,
        data,
    }
}

fn build_admin_only_ix<A: InstructionData>(admin: Pubkey, args: A) -> Instruction {
    let (config, _) = config_pda();
    let metas = ix_accounts::AdminOnly {
        config,
        admin,
        event_authority: event_authority_pda(),
        program: PROGRAM_ID,
    }
    .to_account_metas(None);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas,
        data: args.data(),
    }
}

fn build_accept_admin_ix(new_admin: Pubkey) -> Instruction {
    let (config, _) = config_pda();
    let metas = ix_accounts::AcceptAdmin {
        config,
        new_admin,
        event_authority: event_authority_pda(),
        program: PROGRAM_ID,
    }
    .to_account_metas(None);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas,
        data: ix_args::AcceptAdmin {}.data(),
    }
}

// ---------------------------------------------------------------------------
// Account builders
// ---------------------------------------------------------------------------

fn initial_accounts_for_initialize(payer: Pubkey) -> Vec<(Pubkey, Account)> {
    let (config, _) = config_pda();
    let (system_pk, system_acc) = program::keyed_account_for_system_program();
    vec![
        (config, empty_account()),
        (payer, funded_account(PAYER_LAMPORTS)),
        (system_pk, system_acc),
        (event_authority_pda(), empty_account()),
        (PROGRAM_ID, program::create_program_account_loader_v3(&PROGRAM_ID)),
    ]
}

fn admin_only_accounts(admin: Pubkey, config_account: Account) -> Vec<(Pubkey, Account)> {
    let (config, _) = config_pda();
    vec![
        (config, config_account),
        (admin, funded_account(PAYER_LAMPORTS)),
        (event_authority_pda(), empty_account()),
        (PROGRAM_ID, program::create_program_account_loader_v3(&PROGRAM_ID)),
    ]
}

fn accept_admin_accounts(new_admin: Pubkey, config_account: Account) -> Vec<(Pubkey, Account)> {
    let (config, _) = config_pda();
    vec![
        (config, config_account),
        (new_admin, funded_account(PAYER_LAMPORTS)),
        (event_authority_pda(), empty_account()),
        (PROGRAM_ID, program::create_program_account_loader_v3(&PROGRAM_ID)),
    ]
}

/// Run `initialize` and return the resulting populated config account.
fn initialize_for_test(
    mollusk: &Mollusk,
    payer: Pubkey,
    admin: Pubkey,
    treasury: Pubkey,
    fee_bps: u16,
) -> Account {
    let (config, _) = config_pda();
    let ix = build_initialize_ix(payer, admin, treasury, fee_bps);
    let accounts = initial_accounts_for_initialize(payer);
    let result =
        mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
    get_resulting(&result, config)
}

// ---------------------------------------------------------------------------
// Happy-path tests (1-6)
// ---------------------------------------------------------------------------

#[test]
fn h1_initialize_creates_config_with_expected_values() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let config_account = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let cfg = read_config(&config_account);

    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.treasury, treasury);
    assert_eq!(cfg.fee_bps, 300);
    assert_eq!(cfg.version, 1);
    assert!(!cfg.paused);
    assert_eq!(cfg.pending_admin, None);
    assert_eq!(cfg._reserved, [0u8; 128]);

    // First mutation sets last_updated to clock; treat 0 as the prior baseline.
    assert_post_mutation_invariants(&cfg, 0);
}

#[test]
fn h2_propose_then_accept_admin_rotates() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let new_admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let last_after_init = read_config(&config_after_init).last_updated;

    let propose_ix = build_admin_only_ix(admin, ix_args::ProposeAdmin { new_admin });
    let accounts = admin_only_accounts(admin, config_after_init);
    let propose_result =
        mollusk.process_and_validate_instruction(&propose_ix, &accounts, &[Check::success()]);
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);
    let cfg_propose = read_config(&config_after_propose);
    assert_eq!(cfg_propose.pending_admin, Some(new_admin));
    assert_eq!(cfg_propose.admin, admin);
    assert_post_mutation_invariants(&cfg_propose, last_after_init);

    let accept_ix = build_accept_admin_ix(new_admin);
    let accept_accounts = accept_admin_accounts(new_admin, config_after_propose);
    let accept_result = mollusk.process_and_validate_instruction(
        &accept_ix,
        &accept_accounts,
        &[Check::success()],
    );
    let cfg_accept = read_config(&get_resulting(&accept_result, config_pk));
    assert_eq!(cfg_accept.admin, new_admin);
    assert_eq!(cfg_accept.pending_admin, None);
    assert_post_mutation_invariants(&cfg_accept, cfg_propose.last_updated);
}

#[test]
fn h3_cancel_pending_admin_clears_pending() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let new_admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let propose_ix = build_admin_only_ix(admin, ix_args::ProposeAdmin { new_admin });
    let propose_accounts = admin_only_accounts(admin, config_after_init);
    let propose_result = mollusk.process_and_validate_instruction(
        &propose_ix,
        &propose_accounts,
        &[Check::success()],
    );
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);
    let cfg_propose = read_config(&config_after_propose);
    assert_eq!(cfg_propose.pending_admin, Some(new_admin));

    let cancel_ix = build_admin_only_ix(admin, ix_args::CancelPendingAdmin {});
    let cancel_accounts = admin_only_accounts(admin, config_after_propose);
    let cancel_result = mollusk.process_and_validate_instruction(
        &cancel_ix,
        &cancel_accounts,
        &[Check::success()],
    );
    let cfg_cancel = read_config(&get_resulting(&cancel_result, config_pk));
    assert_eq!(cfg_cancel.pending_admin, None);
    assert_eq!(cfg_cancel.admin, admin);
    assert_post_mutation_invariants(&cfg_cancel, cfg_propose.last_updated);
}

#[test]
fn h4_set_fee_bps_within_cap_updates_fee() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let prev_last_updated = read_config(&config_after_init).last_updated;
    let ix = build_admin_only_ix(admin, ix_args::SetFeeBps { new_bps: 500 });
    let accounts = admin_only_accounts(admin, config_after_init);
    let result =
        mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
    let (config_pk, _) = config_pda();
    let cfg = read_config(&get_resulting(&result, config_pk));
    assert_eq!(cfg.fee_bps, 500);
    assert_post_mutation_invariants(&cfg, prev_last_updated);
}

#[test]
fn h5_set_treasury_to_valid_address_updates_treasury() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let new_treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let prev_last_updated = read_config(&config_after_init).last_updated;
    let ix = build_admin_only_ix(
        admin,
        ix_args::SetTreasury {
            new_treasury,
        },
    );
    let accounts = admin_only_accounts(admin, config_after_init);
    let result =
        mollusk.process_and_validate_instruction(&ix, &accounts, &[Check::success()]);
    let (config_pk, _) = config_pda();
    let cfg = read_config(&get_resulting(&result, config_pk));
    assert_eq!(cfg.treasury, new_treasury);
    assert_post_mutation_invariants(&cfg, prev_last_updated);
}

#[test]
fn h6_post_rotation_old_admin_locked_out_new_admin_can_act() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let new_admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let propose_ix = build_admin_only_ix(admin, ix_args::ProposeAdmin { new_admin });
    let propose_accounts = admin_only_accounts(admin, config_after_init);
    let propose_result = mollusk.process_and_validate_instruction(
        &propose_ix,
        &propose_accounts,
        &[Check::success()],
    );
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);

    let accept_ix = build_accept_admin_ix(new_admin);
    let accept_accounts = accept_admin_accounts(new_admin, config_after_propose);
    let accept_result = mollusk.process_and_validate_instruction(
        &accept_ix,
        &accept_accounts,
        &[Check::success()],
    );
    let config_after_accept = get_resulting(&accept_result, config_pk);
    let cfg_after_accept = read_config(&config_after_accept);
    assert_eq!(cfg_after_accept.admin, new_admin);
    assert_eq!(cfg_after_accept._reserved, [0u8; 128]);

    // Old admin attempting set_fee_bps must be rejected by the `has_one = admin` check.
    let bad_ix = build_admin_only_ix(admin, ix_args::SetFeeBps { new_bps: 700 });
    let bad_accounts = admin_only_accounts(admin, config_after_accept.clone());
    let _ = mollusk.process_and_validate_instruction(
        &bad_ix,
        &bad_accounts,
        &[Check::err(ProgramError::Custom(UNAUTHORIZED))],
    );

    // New admin can update the fee.
    let good_ix = build_admin_only_ix(new_admin, ix_args::SetFeeBps { new_bps: 700 });
    let good_accounts = admin_only_accounts(new_admin, config_after_accept);
    let good_result = mollusk.process_and_validate_instruction(
        &good_ix,
        &good_accounts,
        &[Check::success()],
    );
    let cfg_after_fee = read_config(&get_resulting(&good_result, config_pk));
    assert_eq!(cfg_after_fee.fee_bps, 700);
    assert_post_mutation_invariants(&cfg_after_fee, cfg_after_accept.last_updated);
}

// ---------------------------------------------------------------------------
// Error-path tests (7-18)
// ---------------------------------------------------------------------------

#[test]
fn e7_initialize_with_fee_above_max_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let ix = build_initialize_ix(payer, admin, treasury, MAX_FEE_BPS + 1);
    let accounts = initial_accounts_for_initialize(payer);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(FEE_TOO_HIGH))],
    );
}

#[test]
fn e8_initialize_with_default_treasury_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let ix = build_initialize_ix(payer, admin, Pubkey::default(), 300);
    let accounts = initial_accounts_for_initialize(payer);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(INVALID_TREASURY))],
    );
}

#[test]
fn e9_initialize_with_default_admin_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let ix = build_initialize_ix(payer, Pubkey::default(), treasury, 300);
    let accounts = initial_accounts_for_initialize(payer);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(INVALID_ADMIN))],
    );
}

#[test]
fn e10_initialize_called_twice_hits_anchor_reinit_protection() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_account = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    // Replay initialize; the config PDA is now allocated and owned by the program,
    // so SystemProgram::CreateAccount will reject with AccountAlreadyInUse (custom 0).
    let ix = build_initialize_ix(payer, admin, treasury, 400);
    let mut accounts = initial_accounts_for_initialize(payer);
    let (config_pk, _) = config_pda();
    upsert(&mut accounts, config_pk, config_account);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(ANCHOR_ACCOUNT_ALREADY_INITIALIZED))],
    );
}

#[test]
fn e11_propose_admin_by_non_admin_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let imposter = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let new_admin = Pubkey::new_unique();

    let config_account = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let ix = build_admin_only_ix(imposter, ix_args::ProposeAdmin { new_admin });
    let accounts = admin_only_accounts(imposter, config_account);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(UNAUTHORIZED))],
    );
}

#[test]
fn e12_propose_admin_when_pending_already_set_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let pending = Pubkey::new_unique();
    let other = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let propose_ix = build_admin_only_ix(
        admin,
        ix_args::ProposeAdmin {
            new_admin: pending,
        },
    );
    let propose_accounts = admin_only_accounts(admin, config_after_init);
    let propose_result = mollusk.process_and_validate_instruction(
        &propose_ix,
        &propose_accounts,
        &[Check::success()],
    );
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);

    let dup_ix = build_admin_only_ix(admin, ix_args::ProposeAdmin { new_admin: other });
    let dup_accounts = admin_only_accounts(admin, config_after_propose);
    let _ = mollusk.process_and_validate_instruction(
        &dup_ix,
        &dup_accounts,
        &[Check::err(ProgramError::Custom(PENDING_ADMIN_ALREADY_SET))],
    );
}

#[test]
fn e13_accept_admin_without_pending_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let pretender = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let ix = build_accept_admin_ix(pretender);
    let accounts = accept_admin_accounts(pretender, config_after_init);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(NO_PENDING_ADMIN))],
    );
}

#[test]
fn e14_accept_admin_by_wrong_signer_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let pending = Pubkey::new_unique();
    let imposter = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let propose_ix = build_admin_only_ix(
        admin,
        ix_args::ProposeAdmin {
            new_admin: pending,
        },
    );
    let propose_accounts = admin_only_accounts(admin, config_after_init);
    let propose_result = mollusk.process_and_validate_instruction(
        &propose_ix,
        &propose_accounts,
        &[Check::success()],
    );
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);

    let bad_ix = build_accept_admin_ix(imposter);
    let bad_accounts = accept_admin_accounts(imposter, config_after_propose);
    let _ = mollusk.process_and_validate_instruction(
        &bad_ix,
        &bad_accounts,
        &[Check::err(ProgramError::Custom(UNAUTHORIZED))],
    );
}

#[test]
fn e15_cancel_pending_admin_without_pending_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let ix = build_admin_only_ix(admin, ix_args::CancelPendingAdmin {});
    let accounts = admin_only_accounts(admin, config_after_init);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(NO_PENDING_ADMIN))],
    );
}

#[test]
fn e16_cancel_pending_admin_by_non_admin_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let imposter = Pubkey::new_unique();
    let pending = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let propose_ix = build_admin_only_ix(
        admin,
        ix_args::ProposeAdmin {
            new_admin: pending,
        },
    );
    let propose_accounts = admin_only_accounts(admin, config_after_init);
    let propose_result = mollusk.process_and_validate_instruction(
        &propose_ix,
        &propose_accounts,
        &[Check::success()],
    );
    let (config_pk, _) = config_pda();
    let config_after_propose = get_resulting(&propose_result, config_pk);

    let cancel_ix = build_admin_only_ix(imposter, ix_args::CancelPendingAdmin {});
    let cancel_accounts = admin_only_accounts(imposter, config_after_propose);
    let _ = mollusk.process_and_validate_instruction(
        &cancel_ix,
        &cancel_accounts,
        &[Check::err(ProgramError::Custom(UNAUTHORIZED))],
    );
}

#[test]
fn e17_set_fee_bps_above_max_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let ix = build_admin_only_ix(
        admin,
        ix_args::SetFeeBps {
            new_bps: MAX_FEE_BPS + 1,
        },
    );
    let accounts = admin_only_accounts(admin, config_after_init);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(FEE_TOO_HIGH))],
    );
}

#[test]
fn e18_set_treasury_to_default_fails() {
    let mollusk = mollusk_with_program();
    let payer = Pubkey::new_unique();
    let admin = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();

    let config_after_init = initialize_for_test(&mollusk, payer, admin, treasury, 300);
    let ix = build_admin_only_ix(
        admin,
        ix_args::SetTreasury {
            new_treasury: Pubkey::default(),
        },
    );
    let accounts = admin_only_accounts(admin, config_after_init);
    let _ = mollusk.process_and_validate_instruction(
        &ix,
        &accounts,
        &[Check::err(ProgramError::Custom(INVALID_TREASURY))],
    );
}
