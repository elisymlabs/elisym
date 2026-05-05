#!/usr/bin/env bash
# Run a k6 scenario by name from packages/perf/k6/scenarios/<name>.js.
#
# Usage:
#   bun run perf:run relay_publish
#   bun run perf:run relay_publish -- -e TARGET_VUS=100 -e HOLD_S=120
#
# Pre-conditions:
#   - `bun run perf:up` (strfry/prometheus/grafana running)
#   - For relay_publish: a fixture in k6/fixtures/. The script auto-generates
#     events-5100.json if missing.

set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${PERF_DIR}/../.." && pwd)"

SCENARIO="${1:-}"
shift || true

if [ -z "${SCENARIO}" ]; then
  echo "usage: bun run perf:run <scenario> [-- k6 args]"
  echo
  echo "available scenarios:"
  ls "${PERF_DIR}/k6/scenarios" | sed -E 's/\.js$//' | sed 's/^/  /'
  exit 1
fi

SCENARIO_FILE="${PERF_DIR}/k6/scenarios/${SCENARIO}.js"
if [ ! -f "${SCENARIO_FILE}" ]; then
  echo "!! scenario not found: ${SCENARIO_FILE}"
  exit 1
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "!! k6 not on PATH. install: brew install k6  (mac) or see https://grafana.com/docs/k6/latest/set-up/install-k6/"
  exit 1
fi

# Auto-generate fixture for relay_publish if missing.
if [ "${SCENARIO}" = "relay_publish" ]; then
  FIXTURE="${PERF_DIR}/k6/fixtures/events-5100.json"
  if [ ! -f "${FIXTURE}" ]; then
    echo "==> generating fixture ${FIXTURE}"
    (cd "${REPO_ROOT}" && bun "${PERF_DIR}/scripts/generate-events.ts" \
      --kind 5100 --count 5000 --seed-keys 256 \
      --out "packages/perf/k6/fixtures/events-5100.json")
  fi
fi

REPORTS_DIR="${PERF_DIR}/k6/reports"
mkdir -p "${REPORTS_DIR}"

RUN_ID="${SCENARIO}-$(date +%Y%m%d-%H%M%S)"

echo "==> k6 run ${SCENARIO} (RUN_ID=${RUN_ID})"
echo "    summary: ${REPORTS_DIR}/${SCENARIO}-${RUN_ID}.{json,html}"
echo

# k6 writes summary files to /reports inside its mental path; we simulate that
# by passing the absolute reports dir as an env var the stats helper reads.
# (See k6/lib/stats.js: it writes to /reports/<scenario>-<run>.{json,html}.)
# We override that path here by writing summary in handleSummary using a
# host-absolute path embedded via env.

K6_OUT="experimental-prometheus-rw"
K6_PROM_RW_URL="${K6_PROM_RW_URL:-http://localhost:9090/api/v1/write}"

cd "${PERF_DIR}"

K6_PROMETHEUS_RW_SERVER_URL="${K6_PROM_RW_URL}" \
K6_PROMETHEUS_RW_TREND_STATS="p(50),p(95),p(99),min,max,avg" \
SCENARIO="${SCENARIO}" \
RUN_ID="${RUN_ID}" \
REPORTS_DIR="${REPORTS_DIR}" \
  k6 run \
    --out "${K6_OUT}" \
    --tag scenario="${SCENARIO}" \
    --tag run_id="${RUN_ID}" \
    "$@" \
    "${SCENARIO_FILE}"

echo
echo "==> done. Reports:"
ls -1 "${REPORTS_DIR}" | grep "${RUN_ID}" | sed 's/^/  /' || true
echo
echo "Grafana: http://localhost:3000"
