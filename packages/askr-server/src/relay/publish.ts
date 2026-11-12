import type { NostrEvent } from 'nostr-tools';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import type { ServerPool } from './pool';

/** nostr-tools' rejection when the relay sent no OK in time: no answer, not a refusal. */
const PUBLISH_TIMED_OUT = 'publish timed out';

export type PublishOutcome =
  | { status: 'accepted' }
  | { status: 'refused'; reason: string }
  | { status: 'unreachable'; reason: string };

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish one event to the relay and tell an explicit refusal (the relay's OK
 * false, with its reason) from a relay that could not be reached, dropped the
 * connection or did not answer in time.
 */
export async function publishToRelay(
  pool: Pick<ServerPool, 'ensureRelay'>,
  relayUrl: string,
  event: NostrEvent,
): Promise<PublishOutcome> {
  let relay;
  try {
    relay = await pool.ensureRelay(relayUrl, { connectionTimeout: CONNECTION_TIMEOUT_MS });
  } catch (error) {
    return { status: 'unreachable', reason: messageOf(error) };
  }
  try {
    await relay.publish(event);
    return { status: 'accepted' };
  } catch (error) {
    const reason = messageOf(error);
    // A connection that went away rejects every publish in flight with its close reason.
    if (!relay.connected || reason === PUBLISH_TIMED_OUT) {
      return { status: 'unreachable', reason };
    }
    return { status: 'refused', reason };
  }
}
