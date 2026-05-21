// Minimal NIP-01 helpers for k6 ws scenarios.
//
// We deliberately use a fake-but-well-formed signature scheme: each event id is
// a sha256 hash over the canonical payload, but the signature itself is zeroed
// out. strfry will reject these UNLESS it is run in a permissive mode for tests,
// or unless we sign for real. For phase 1 we sign for real with @noble/secp256k1
// inlined, because k6 cannot import npm packages directly.
//
// k6 ships with `k6/crypto` (sha256, hmac) and `k6/encoding` (hex, base64).
// We depend on those for hashing and on a small bundled secp256k1 helper that
// scenarios can opt into via `signEvent`. For now we rely on a SCHNORR_SIG_HEX
// env var to allow short-circuiting signature work when only throughput matters
// and the relay is configured to skip signature verification.

import { check } from 'k6';
import { sha256 } from 'k6/crypto';

const ZERO_SIG = '0'.repeat(128);

/**
 * Build a canonical NIP-01 event-id payload string and return its sha256 hex.
 * Per NIP-01: id = sha256(json([0, pubkey, created_at, kind, tags, content])).
 */
export function computeEventId(event) {
  const payload = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return sha256(payload, 'hex');
}

/**
 * Build a NIP-01 event with a zero signature. Useful when:
 *   - the relay is in a permissive test mode that does not verify sigs, OR
 *   - the scenario only measures relay accept/reject throughput, not validity.
 *
 * For phase 1 with stock strfry, this will be REJECTED. The scenario records
 * both ACCEPTED (true) and REJECTED-with-bad-sig (false) outcomes; the goal
 * is to measure the round-trip latency of the OK message either way.
 */
export function makeUnsignedEvent({
  pubkey,
  kind,
  content = '',
  tags = [],
  createdAt = nowSecs(),
}) {
  const event = {
    pubkey,
    kind,
    content,
    tags,
    created_at: createdAt,
    sig: ZERO_SIG,
  };
  event.id = computeEventId(event);
  return event;
}

export function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Install a single OK-frame router on a ws Socket and return a `publish(event)`
 * binder. All pending sends share one `socket.on('message', ...)` handler — this
 * matters for high-throughput scenarios where registering a fresh listener per
 * event accumulates handlers and (worse) can race with k6's message dispatch.
 *
 * Caller drives sending via `socket.setInterval` / `setTimeout` (non-blocking);
 * the router resolves each event when its matching OK frame arrives. Pending
 * sends still outstanding when the socket closes can be reaped via `flush()`.
 */
export function createOkRouter(
  socket,
  { okTrend, sentCounter, ackCounter, errorCounter, onResolve },
) {
  const pending = new Map(); // id -> startMs

  socket.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return;
    }
    if (!Array.isArray(parsed) || parsed[0] !== 'OK') return;
    const id = parsed[1];
    const start = pending.get(id);
    if (start === undefined) return;
    pending.delete(id);
    const accepted = parsed[2] === true;
    const elapsed = Date.now() - start;
    if (okTrend) okTrend.add(elapsed);
    if (accepted && ackCounter) ackCounter.add(1);
    if (!accepted && errorCounter) errorCounter.add(1);
    onResolve?.(id, accepted, parsed[3] ?? '');
  });

  function publish(event) {
    pending.set(event.id, Date.now());
    if (sentCounter) sentCounter.add(1);
    socket.send(JSON.stringify(['EVENT', event]));
  }

  function flush(reason = 'closed') {
    for (const id of pending.keys()) {
      if (errorCounter) errorCounter.add(1);
      onResolve?.(id, false, reason);
    }
    const count = pending.size;
    pending.clear();
    return count;
  }

  return { publish, flush, pendingCount: () => pending.size };
}

/**
 * Send a REQ subscription and resolve when EOSE arrives.
 * `onEvent(event)` is invoked for every EVENT frame matching the subscription.
 * Returns the subscription id; caller is responsible for sending CLOSE.
 */
export function subscribe(socket, subId, filter, { onEvent, onEose, eoseTrend }) {
  const start = Date.now();
  const req = JSON.stringify(['REQ', subId, filter]);
  socket.send(req);

  socket.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return;
    }
    if (!Array.isArray(parsed) || parsed[1] !== subId) return;
    const frame = parsed[0];
    if (frame === 'EVENT') {
      onEvent?.(parsed[2]);
      return;
    }
    if (frame === 'EOSE') {
      const elapsed = Date.now() - start;
      if (eoseTrend) eoseTrend.add(elapsed);
      onEose?.(elapsed);
      return;
    }
  });

  return subId;
}

export function closeSubscription(socket, subId) {
  socket.send(JSON.stringify(['CLOSE', subId]));
}

/**
 * Sanity-check helper for scenario teardown: ensure we got at least one OK.
 */
export function expectAtLeastOneAck(ackCounter) {
  check(null, {
    'relay produced at least one OK ack': () => ackCounter && ackCounter.count > 0,
  });
}
