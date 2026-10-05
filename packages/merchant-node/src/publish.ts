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

/** A relay that could not be reached (no connection, or no answer in time): not a refusal. */
class UnreachableError extends Error {}

/**
 * Relays found unreachable during one run of publishes: skipped for the rest of
 * it, so a dead relay costs one deadline per setup, not one per event. A relay
 * that refuses an event (OK false) is not tripped: it answered.
 */
export type RelayBreaker = Set<string>;

/** nostr-tools' own publish timeout: the relay never answered, which is not a refusal. */
const NO_ANSWER = 'publish timed out';

/** A publish whose relay never answered becomes `UnreachableError`; a relay's refusal stays as it is. */
async function answered(publishing: Promise<string>): Promise<string> {
  try {
    return await publishing;
  } catch (error) {
    if (error instanceof Error && error.message === NO_ANSWER) {
      throw new UnreachableError(NO_ANSWER);
    }
    throw error;
  }
}

async function publishOne(
  pool: PublishPool,
  url: string,
  event: NostrEvent,
  auth: AuthSigner,
): Promise<void> {
  let relay: PublishRelay;
  try {
    relay = await pool.ensureRelay(url);
  } catch (error) {
    throw new UnreachableError(errorText(error));
  }
  try {
    await answered(relay.publish(event));
  } catch (error) {
    // A relay that takes writes only from an authenticated key asks once; the
    // store key signs and the event goes again. Any other refusal stands.
    if (!errorText(error).startsWith('auth-required')) {
      throw error;
    }
    await relay.auth(auth);
    await answered(relay.publish(event));
  }
}

/**
 * Publish to each relay on its own and return the ones that answered OK (the
 * pool's own publish counts a connection failure as an answer). Each relay has
 * one overall deadline. With a `breaker`, a relay it holds is skipped, and one
 * that cannot be reached or times out is added to it.
 */
export async function publishToRelays(
  pool: PublishPool,
  relays: readonly string[],
  event: NostrEvent,
  auth: AuthSigner,
  log: (message: string) => void,
  deadlineMs = PUBLISH_DEADLINE_MS,
  breaker?: RelayBreaker,
): Promise<string[]> {
  const accepted: string[] = [];
  await Promise.all(
    relays.map(async (url) => {
      if (breaker?.has(url) === true) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UnreachableError('timed out')), deadlineMs);
      });
      try {
        await Promise.race([publishOne(pool, url, event, auth), deadline]);
        accepted.push(url);
      } catch (error) {
        log(`publish to ${url} failed: ${errorText(error)}`);
        if (breaker !== undefined && error instanceof UnreachableError) {
          breaker.add(url);
          log(`${url} skipped for the rest of this setup`);
        }
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return accepted;
}

/**
 * How a setup publishes: every event to `relays` with one breaker for the
 * whole setup (a dead relay costs one deadline, not one per event), noting
 * each event no relay of `defaultRelays` took (every page reads those).
 */
export function setupPublisher(
  pool: PublishPool,
  relays: readonly string[],
  defaultRelays: readonly string[],
  auth: AuthSigner,
  log: (message: string) => void,
  deadlineMs = PUBLISH_DEADLINE_MS,
): { publish: (event: NostrEvent, name: string) => Promise<boolean>; missedDefaults: string[] } {
  const breaker: RelayBreaker = new Set();
  const missedDefaults: string[] = [];
  const publish = async (event: NostrEvent, name: string) => {
    const accepted = await publishToRelays(pool, relays, event, auth, log, deadlineMs, breaker);
    log(`${name}: accepted by ${accepted.length}/${relays.length}`);
    if (!accepted.some((relay) => defaultRelays.includes(relay))) {
      missedDefaults.push(name);
    }
    return accepted.length > 0;
  };
  return { publish, missedDefaults };
}
