import type { NostrEvent } from 'nostr-tools';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import { PUBLISH_DEADLINE_MS } from './constants';

export type AuthSigner = (template: EventTemplate) => Promise<VerifiedEvent>;

/** The part of a connected nostr-tools relay a publish uses. */
export interface PublishRelay {
  /** Resolves only on the relay's OK true; rejects on a refusal or a timeout. */
  publish(event: NostrEvent): Promise<string>;
  auth(signer: AuthSigner): Promise<string>;
}

export interface PublishPool {
  ensureRelay(url: string): Promise<PublishRelay>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishOne(
  pool: PublishPool,
  url: string,
  event: NostrEvent,
  auth: AuthSigner,
): Promise<void> {
  const relay = await pool.ensureRelay(url);
  try {
    await relay.publish(event);
  } catch (error) {
    // A relay that takes writes only from an authenticated key asks once; the
    // store key signs and the event goes again. Any other refusal stands.
    if (!errorText(error).startsWith('auth-required')) {
      throw error;
    }
    await relay.auth(auth);
    await relay.publish(event);
  }
}

/**
 * Publish to each relay on its own and return the ones that answered OK (the
 * pool's own publish counts a connection failure as an answer). Each relay has
 * one overall deadline.
 */
export async function publishToRelays(
  pool: PublishPool,
  relays: readonly string[],
  event: NostrEvent,
  auth: AuthSigner,
  log: (message: string) => void,
  deadlineMs = PUBLISH_DEADLINE_MS,
): Promise<string[]> {
  const accepted: string[] = [];
  await Promise.all(
    relays.map(async (url) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), deadlineMs);
      });
      try {
        await Promise.race([publishOne(pool, url, event, auth), deadline]);
        accepted.push(url);
      } catch (error) {
        log(`publish to ${url} failed: ${errorText(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return accepted;
}
