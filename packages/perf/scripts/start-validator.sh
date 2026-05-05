#!/usr/bin/env bash
# Start solana-test-validator on the host with --reset and elisym-config
# pre-loaded from target/deploy.
#
# Why on host (not in docker): the official Solana team does not maintain a
# current docker image, and devs working on this repo already have the Solana
# CLI installed (anchor depends on it). Keeping it on the host avoids a
# brittle third-party image dependency.
#
# Usage:
#   bun run perf:validator               # start in foreground; Ctrl+C to stop
#   bun run perf:validator -- --reset    # extra flags forwarded
set -euo pipefail

if ! command -v solana-test-validator >/dev/null 2>&1; then
  cat <<EOF
!! solana-test-validator not found on PATH.
   install Solana CLI: https://docs.solanalabs.com/cli/install
   or via anza-xyz/agave release (current upstream).
EOF
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROGRAM_SO="${REPO_ROOT}/target/deploy/elisym_config.so"
PROGRAM_ID="BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE"

EXTRA_ARGS=()
if [ -f "${PROGRAM_SO}" ]; then
  echo "==> loading elisym-config program from ${PROGRAM_SO}"
  EXTRA_ARGS+=(--bpf-program "${PROGRAM_ID}" "${PROGRAM_SO}")
else
  echo "!! ${PROGRAM_SO} missing; run 'bun run program:build' first to load the program automatically."
  echo "   continuing without elisym-config; protocol_config_cache scenario will fail until you load it."
fi

# Ledger lives in target/test-validator-ledger so it can be cleaned with the
# rest of build artifacts via 'bun run clean' at the workspace level.
LEDGER_DIR="${REPO_ROOT}/target/test-validator-ledger"
mkdir -p "${LEDGER_DIR}"

echo "==> solana-test-validator (ledger=${LEDGER_DIR})"
exec solana-test-validator \
  --reset \
  --quiet \
  --ledger "${LEDGER_DIR}" \
  --rpc-port 8899 \
  --bind-address 0.0.0.0 \
  "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
  "$@"
