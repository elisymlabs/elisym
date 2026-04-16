# Elisym Solana Programs

## Setup

1. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. Install Solana CLI (Agave): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
3. Install avm (Anchor version manager): `cargo install --git https://github.com/coral-xyz/anchor avm --force`
4. Install Anchor 1.0.0: `avm install 1.0.0 && avm use 1.0.0`
5. Verify: `anchor --version` should print `anchor-cli 1.0.0`

## Build / Test / Deploy

- `bun run program:build` - compile all programs
- `bun run program:test` - run Mollusk unit tests (Rust)
- `bun run program:deploy:devnet` - deploy to devnet (requires funded wallet)

## Program layout

- `elisym-config/` - protocol fee / treasury / admin configuration
