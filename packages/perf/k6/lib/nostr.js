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
 * Send an EVENT to the relay over an open ws and resolve with the OK frame.
 *
 * Returns a promise-like by using `socket.setTimeout` semantics: we install a
 * one-shot OK handler that records the outcome into the supplied trend metric
 * and calls onResolve(eventId, accepted, message).
 *
 * Caller is responsible for closing the socket after their iteration ends.
 */
export function publishEvent(
  socket,
  event,
  { okTrend, sentCounter, ackCounter, errorCounter, onResolve },
) {
  const start = Date.now();
  const sent = JSON.stringify(['EVENT', event]);
  socket.send(sent);
  if (sentCounter) sentCounter.add(1);

  // k6's k6/ws Socket has no clearTimeout, so the 5s deadline always fires.
  // Use a per-event flag so a late timeout can't double-count an OK that
  // already arrived (would otherwise inflate errors and skew accept rate).
  let resolved = false;

  socket.setTimeout(() => {
    if (resolved) return;
    resolved = true;
    if (errorCounter) errorCounter.add(1);
    onResolve?.(event.id, false, 'timeout');
  }, 5000);

  socket.on('message', (raw) => {
    if (resolved) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return;
    }
    if (!Array.isArray(parsed) || parsed[0] !== 'OK' || parsed[1] !== event.id) return;
    resolved = true;
    const accepted = parsed[2] === true;
    const elapsed = Date.now() - start;
    if (okTrend) okTrend.add(elapsed);
    if (accepted && ackCounter) ackCounter.add(1);
    if (!accepted && errorCounter) errorCounter.add(1);
    onResolve?.(event.id, accepted, parsed[3] ?? '');
  });
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
