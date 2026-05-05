#!/usr/bin/env bash
set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${PERF_DIR}/docker/docker-compose.yml"

KEEP_VOLUMES="${KEEP_VOLUMES:-0}"

if [ "${KEEP_VOLUMES}" = "1" ]; then
  echo "==> docker compose down (keeping volumes)"
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans
else
  echo "==> docker compose down -v (wiping volumes)"
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans -v
fi
