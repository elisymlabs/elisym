#!/usr/bin/env bash
# Bring up the local perf stack: strfry + prometheus + grafana.
# Phase 1 only; later phases extend docker-compose.yml with test-validator,
# anchor-deploy (one-shot), bridge, and provider services.

set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${PERF_DIR}/docker/docker-compose.yml"

echo "==> docker compose up (file: ${COMPOSE_FILE})"
docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans

echo "==> waiting for strfry (ws://localhost:7777)"
for i in $(seq 1 30); do
  if curl -fsS --max-time 1 -o /dev/null \
       -H "Upgrade: websocket" \
       -H "Connection: Upgrade" \
       -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
       -H "Sec-WebSocket-Version: 13" \
       "http://localhost:7777/" 2>/dev/null \
     || curl -fsS --max-time 1 -o /dev/null "http://localhost:7777/" 2>/dev/null; then
    echo "    strfry up after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = 30 ]; then
    echo "!! strfry did not respond on :7777 after 30s; check 'docker compose logs strfry'"
    exit 1
  fi
done

echo "==> waiting for prometheus (http://localhost:9090)"
for i in $(seq 1 30); do
  if curl -fsS --max-time 1 -o /dev/null "http://localhost:9090/-/ready"; then
    echo "    prometheus up after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = 30 ]; then
    echo "!! prometheus not ready on :9090 after 30s"
    exit 1
  fi
done

echo "==> waiting for grafana (http://localhost:3000)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 1 -o /dev/null "http://localhost:3000/api/health"; then
    echo "    grafana up after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = 60 ]; then
    echo "!! grafana not ready on :3000 after 60s"
    exit 1
  fi
done

echo
echo "stack ready:"
echo "  strfry      ws://localhost:7777"
echo "  prometheus  http://localhost:9090"
echo "  grafana     http://localhost:3000   (anonymous viewer)"
echo
echo "next: bun run perf:run relay_publish"
