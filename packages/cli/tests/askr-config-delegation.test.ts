import * as askr from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  randomEventSet,
  seededRandom,
  withoutSigner,
} from '../../askr/tests/shared/config-event-sets';
import { MAX_AHEAD_SECS } from '../src/commands/askr/constants';
import { newestParseableConfig } from '../src/commands/askr/read';

const NOW = 1_800_000_000;
const ownerSecret = generateSecretKey();
const OWNER = getPublicKey(ownerSecret);
const INPUT: askr.StoreConfigInput = {
  assistant: getPublicKey(generateSecretKey()),
  origins: ['https://shop.example'],
  name: 'Tea Shop',
  language: 'en',
  currency: 'USD',
  source: { kind: 'catalog' },
  catalogKey: getPublicKey(generateSecretKey()),
};

/** The config pick of `readSigned` as it was before config delegation (frozen for 9.1). */
function frozenPick(events: readonly NostrEvent[], owner: string, now: number) {
  const genuine = events.filter(
    (event) =>
      event.pubkey === owner &&
      event.created_at <= now + MAX_AHEAD_SECS &&
      verifyEvent(JSON.parse(JSON.stringify(event))),
  );
  const isNewer = (candidate: NostrEvent, current: NostrEvent) =>
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id);
  const configs = genuine
    .filter(
      (event) =>
        event.kind === askr.KIND_CONFIG &&
        event.tags.find((tag) => tag[0] === 'd')?.[1] === askr.CONFIG_D_TAG,
    )
    .sort((left, right) => (isNewer(left, right) ? -1 : 1));
  for (const event of configs) {
    const config = askr.parseConfig(event);
    if (config !== undefined) {
      return config;
    }
  }
  return undefined;
}

describe('askr CLI config pick with config delegation (askr-shopify 1.3, 9.1)', () => {
  it('equals the pre-delegation pick over random event sets without 30498', () => {
    const random = seededRandom(5);
    const owner = { secretKey: ownerSecret, pubkey: OWNER };
    let found = 0;
    for (let round = 0; round < 80; round += 1) {
      const events = randomEventSet(random, { owner, now: NOW, input: INPUT });
      const before = frozenPick(events, OWNER, NOW);
      found += before === undefined ? 0 : 1;
      expect(withoutSigner(newestParseableConfig(askr, events, OWNER, NOW))).toEqual(
        withoutSigner(before),
      );
    }
    expect(found).toBeGreaterThan(10);
    expect(found).toBeLessThan(70);
  }, 180_000);

  it("takes an active delegate's newer config, and the owner's once it is revoked", () => {
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const events = [
      finalizeEvent(
        askr.buildConfigEvent({ ...INPUT, createdAt: NOW - 100 }, ownerSecret),
        ownerSecret,
      ),
      finalizeEvent(
        askr.buildConfigDelegation({ key: delegate, createdAt: NOW - 90 }),
        ownerSecret,
      ),
      finalizeEvent(
        askr.buildConfigEvent({ ...INPUT, name: 'Delegated', createdAt: NOW - 10 }, delegateSecret),
        delegateSecret,
      ),
    ];
    const picked = newestParseableConfig(askr, events, OWNER, NOW);
    expect([picked?.name, picked?.owner, picked?.signer]).toEqual(['Delegated', OWNER, delegate]);
    const revoked = [
      ...events,
      finalizeEvent(askr.buildConfigDelegationRevocation(delegate, NOW - 5), ownerSecret),
    ];
    expect(newestParseableConfig(askr, revoked, OWNER, NOW)?.name).toBe('Tea Shop');
  });
});
