import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  type StoreConfigInput,
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  randomEventSet,
  seededRandom,
  withoutSigner,
} from '../../askr/tests/shared/config-event-sets';
import type { RelayReader } from '../src/lib/relay';
import { type ConfigRead, newestByD, readConfig } from '../src/lib/store-data';
import { ownSignedEvents } from '../src/lib/stored-events';
import { fakeReader } from './fakes';

const NOW = 1_800_000_000;
const ownerSecret = generateSecretKey();
const OWNER = getPublicKey(ownerSecret);
const INPUT: StoreConfigInput = {
  assistant: getPublicKey(generateSecretKey()),
  origins: ['https://shop.example'],
  name: 'Tea Shop',
  language: 'en',
  currency: 'USD',
  source: { kind: 'catalog' },
  catalogKey: getPublicKey(generateSecretKey()),
};

/** `readConfig` as it was before config delegation (frozen for 9.1). */
async function frozenReadConfig(
  reader: RelayReader,
  owner: string,
  now: number,
): Promise<ConfigRead> {
  const events = await reader.query({
    kinds: [KIND_CONFIG],
    authors: [owner],
    '#d': [CONFIG_D_TAG],
  });
  const [newest] = newestByD(events, KIND_CONFIG, owner, now);
  if (newest === undefined) {
    return { state: 'none' };
  }
  const config = parseConfig(newest);
  if (config !== undefined) {
    return { state: 'ok', config, id: newest.id };
  }
  const older = events
    .filter((event) => event.id !== newest.id && event.created_at <= newest.created_at)
    .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
  for (const event of older.filter(
    (candidate) => newestByD([candidate], KIND_CONFIG, owner, now).length === 1,
  )) {
    const fallback = parseConfig(event);
    if (fallback !== undefined) {
      return { state: 'unreadable', newestAt: newest.created_at, fallback, fallbackId: event.id };
    }
  }
  return {
    state: 'unreadable',
    newestAt: newest.created_at,
    fallback: undefined,
    fallbackId: undefined,
  };
}

function comparable(read: ConfigRead) {
  if (read.state === 'ok') {
    return { ...read, config: withoutSigner(read.config) };
  }
  if (read.state === 'unreadable') {
    return { ...read, fallback: withoutSigner(read.fallback) };
  }
  return read;
}

function delegateConfig(secret: Uint8Array, createdAt: number, name: string): NostrEvent {
  return finalizeEvent(buildConfigEvent({ ...INPUT, name, createdAt }, secret), secret);
}

describe('admin config reader with config delegation (askr-shopify 1.3, 9.1)', () => {
  it('equals the pre-delegation reader over random event sets without 30498', async () => {
    const random = seededRandom(3);
    const owner = { secretKey: ownerSecret, pubkey: OWNER };
    const states = new Set<string>();
    for (let round = 0; round < 80; round += 1) {
      const reader = fakeReader(randomEventSet(random, { owner, now: NOW, input: INPUT }));
      const before = await frozenReadConfig(reader, OWNER, NOW);
      states.add(before.state);
      expect(comparable(await readConfig(reader, OWNER, NOW))).toEqual(comparable(before));
    }
    expect([...states].sort()).toEqual(['none', 'ok', 'unreadable']);
  }, 180_000);

  it("reads an active delegate's newer config; a revoked one's is no candidate", async () => {
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const events = [
      finalizeEvent(buildConfigEvent({ ...INPUT, createdAt: NOW - 100 }, ownerSecret), ownerSecret),
      finalizeEvent(buildConfigDelegation({ key: delegate, createdAt: NOW - 90 }), ownerSecret),
      delegateConfig(delegateSecret, NOW - 10, 'Delegated'),
    ];
    const read = await readConfig(fakeReader(events), OWNER, NOW);
    expect(read.state === 'ok' ? [read.config.name, read.config.signer] : read).toEqual([
      'Delegated',
      delegate,
    ]);
    const revoked = [
      ...events,
      finalizeEvent(buildConfigDelegationRevocation(delegate, NOW - 5), ownerSecret),
    ];
    const after = await readConfig(fakeReader(revoked), OWNER, NOW);
    expect(after.state === 'ok' ? after.config.name : after).toBe('Tea Shop');
  });

  it('a deletion-based revocation, then a newer delegate config, is no candidate', async () => {
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const events = [
      finalizeEvent(buildConfigEvent({ ...INPUT, createdAt: NOW - 100 }, ownerSecret), ownerSecret),
      finalizeEvent(buildConfigDelegation({ key: delegate, createdAt: NOW - 90 }), ownerSecret),
      finalizeEvent(
        {
          kind: 5,
          created_at: NOW - 50,
          tags: [['a', `30498:${OWNER}:${delegate}`]],
          content: '',
        },
        ownerSecret,
      ),
      delegateConfig(delegateSecret, NOW - 10, 'Delegated'),
    ];
    const read = await readConfig(fakeReader(events), OWNER, NOW);
    expect(read.state === 'ok' ? read.config.name : read).toBe('Tea Shop');
  });

  it("stored events keep an active delegate's config and deletions, nothing else of it", () => {
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const ownConfig = finalizeEvent(
      buildConfigEvent({ ...INPUT, createdAt: NOW - 100 }, ownerSecret),
      ownerSecret,
    );
    const config = delegateConfig(delegateSecret, NOW - 10, 'Delegated');
    const other = finalizeEvent(
      { kind: 30402, created_at: NOW - 10, tags: [['d', 'x']], content: '' },
      delegateSecret,
    );
    expect(
      ownSignedEvents([ownConfig, config, other], OWNER, NOW).map((event) => event.id),
    ).toEqual([ownConfig.id]);
    const grant = finalizeEvent(
      buildConfigDelegation({ key: delegate, createdAt: NOW - 90 }),
      ownerSecret,
    );
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW - 5,
        tags: [['a', `${KIND_CONFIG}:${delegate}:${CONFIG_D_TAG}`]],
        content: '',
      },
      delegateSecret,
    );
    expect(
      ownSignedEvents([ownConfig, grant, config, deletion, other], OWNER, NOW).map(
        (event) => event.id,
      ),
    ).toEqual([ownConfig.id, grant.id, config.id, deletion.id]);
  });
});
