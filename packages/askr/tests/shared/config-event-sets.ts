/**
 * Random event sets without any 30498, for the per-reader equivalence tests
 * (askr-shopify plan 9.1): each config reader run over one of these must give
 * the same result as its pre-delegation code. Shared by the reader packages'
 * tests through a relative import; it uses only the published `@elisym/askr`
 * surface.
 */
import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  type StoreConfig,
  type StoreConfigInput,
  buildCatalogAuth,
  buildConfigEvent,
} from '@elisym/askr';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const KIND_DELETION = 5;
/** Past the 15-minute future skew every reader allows by default. */
const FAR_FUTURE_SECS = 20 * 60;

export interface SetKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function setKey(): SetKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface EventSetOptions {
  owner: SetKey;
  now: number;
  /** The config every valid event in the set is built from (`createdAt` is set per event). */
  input: StoreConfigInput;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error('empty choice');
  }
  return value;
}

function sign(template: EventTemplate, key: SetKey): NostrEvent {
  return fresh(finalizeEvent(template, key.secretKey));
}

/** The event as a relay hands it over: plain JSON, no cached signature check. */
function fresh(event: NostrEvent): NostrEvent {
  const copy: NostrEvent = JSON.parse(JSON.stringify(event));
  return copy;
}

/**
 * One random set: up to four owner configs (valid, unparseable, forged, other
 * `d`, far future), same-second ties, up to two owner deletions of the config
 * address, a catalog grant, a foreign config and an unrelated deletion.
 */
export function randomEventSet(random: () => number, options: EventSetOptions): NostrEvent[] {
  const { owner, now, input } = options;
  // now + 12 min: past the CLI's 10-minute skew, inside the 15 minutes of the other readers.
  const times = [
    now - 30,
    now - 20,
    now - 20,
    now - 10,
    now + 60,
    now + 12 * 60,
    now + FAR_FUTURE_SECS,
  ];
  const events: NostrEvent[] = [];
  const configCount = Math.floor(random() * 5);
  for (let index = 0; index < configCount; index += 1) {
    const createdAt = pick(random, times);
    const name = `shop ${index}`;
    const valid = sign(buildConfigEvent({ ...input, name, createdAt }, owner.secretKey), owner);
    const variant = pick(random, ['valid', 'valid', 'unparseable', 'forged', 'other-d'] as const);
    if (variant === 'valid') {
      events.push(valid);
    } else if (variant === 'unparseable') {
      events.push(
        sign(
          { kind: KIND_CONFIG, created_at: createdAt, tags: [['d', CONFIG_D_TAG]], content: '' },
          owner,
        ),
      );
    } else if (variant === 'forged') {
      const other = sign({ ...valid, created_at: createdAt + 1 }, owner);
      // Rebuilt from JSON: a spread would carry nostr-tools' cached "verified" mark along.
      events.push(fresh({ ...valid, sig: other.sig }));
    } else {
      events.push(sign({ ...valid, tags: [['d', 'not-askr'], ...valid.tags.slice(1)] }, owner));
    }
  }
  const deletionCount = Math.floor(random() * 3);
  for (let index = 0; index < deletionCount; index += 1) {
    events.push(
      sign(
        {
          kind: KIND_DELETION,
          created_at: pick(random, times),
          tags: [['a', `${KIND_CONFIG}:${owner.pubkey}:${CONFIG_D_TAG}`]],
          content: '',
        },
        owner,
      ),
    );
  }
  if (random() < 0.5) {
    events.push(
      sign(buildCatalogAuth({ key: input.catalogKey, mode: 'hosted', createdAt: now - 40 }), owner),
    );
  }
  if (random() < 0.3) {
    const stranger = setKey();
    events.push(
      sign(
        buildConfigEvent({ ...input, name: 'stranger', createdAt: now - 5 }, stranger.secretKey),
        stranger,
      ),
    );
  }
  if (random() < 0.3) {
    events.push(
      sign(
        {
          kind: KIND_DELETION,
          created_at: now - 5,
          tags: [['a', `30402:${owner.pubkey}:item`]],
          content: '',
        },
        owner,
      ),
    );
  }
  // Relay order is not newest first.
  return events.sort(() => random() - 0.5);
}

/** A config with the field added for delegation (`signer`) taken out, for comparing with old code. */
export function withoutSigner(config: StoreConfig | undefined): StoreConfig | undefined {
  if (config === undefined) {
    return undefined;
  }
  const { signer: _signer, ...rest } = config;
  return rest;
}
