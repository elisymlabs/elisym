import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  type StoreConfigInput,
  type SyncRelayClient,
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import { newestSigned } from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { randomEventSet, seededRandom } from '../../askr/tests/shared/config-event-sets';
import { configWarning } from '../src/tools/askr.js';

const NOW = Math.floor(Date.now() / 1000);
const ownerSecret = generateSecretKey();
const OWNER = getPublicKey(ownerSecret);
const CATALOG = getPublicKey(generateSecretKey());
const INPUT: StoreConfigInput = {
  assistant: getPublicKey(generateSecretKey()),
  origins: ['https://shop.example'],
  name: 'Tea Shop',
  language: 'en',
  currency: 'USD',
  source: { kind: 'catalog' },
  catalogKey: CATALOG,
};

function relayOf(events: readonly NostrEvent[]): SyncRelayClient {
  return {
    query: async (_relays: readonly string[], filter: Filter) =>
      events.filter((event) => matchFilter(filter, event)),
    publish: async () => undefined,
    close: () => undefined,
  };
}

/** `configWarning` as it was before config delegation (frozen for 9.1). */
async function frozenConfigWarning(
  client: SyncRelayClient,
  store: string,
  key: string,
  role: 'products' | 'policies',
): Promise<string | undefined> {
  let events: NostrEvent[];
  try {
    events = await client.query([], {
      kinds: [KIND_CONFIG],
      authors: [store],
      '#d': [CONFIG_D_TAG],
    });
  } catch {
    return 'Could not read the store config to check that visitors will see this.';
  }
  const newest = newestSigned(events, KIND_CONFIG, store, NOW, CONFIG_D_TAG);
  const config = newest === undefined ? undefined : parseConfig(newest);
  if (config === undefined) {
    return 'The store has no published config yet: visitors see nothing until the owner finishes onboarding in the Askr admin.';
  }
  const named = role === 'products' ? config.catalogKey : config.policyKey;
  if (named !== key) {
    return `The store config reads its ${role} from another key: visitors will not see these ${role} until the owner names this catalog key as the store's ${role === 'products' ? 'product source' : 'policy key'} in the Askr admin.`;
  }
  return undefined;
}

describe('askr MCP config warning with config delegation (askr-shopify 1.3, 9.1)', () => {
  it('equals the pre-delegation warning over random event sets without 30498', async () => {
    const random = seededRandom(11);
    const owner = { secretKey: ownerSecret, pubkey: OWNER };
    const warnings = new Set<string | undefined>();
    for (let round = 0; round < 80; round += 1) {
      const client = relayOf(randomEventSet(random, { owner, now: NOW, input: INPUT }));
      const role = round % 2 === 0 ? 'products' : 'policies';
      const before = await frozenConfigWarning(client, OWNER, CATALOG, role);
      warnings.add(before);
      expect(await configWarning(client, OWNER, CATALOG, role)).toBe(before);
    }
    expect(warnings.has(undefined)).toBe(true);
    expect(warnings.size).toBeGreaterThan(1);
  }, 180_000);

  it("a store whose only config is an active delegate's gets no false 'no published config'", async () => {
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const events = [
      finalizeEvent(buildConfigDelegation({ key: delegate, createdAt: NOW - 90 }), ownerSecret),
      finalizeEvent(
        buildConfigEvent({ ...INPUT, createdAt: NOW - 10 }, delegateSecret),
        delegateSecret,
      ),
    ];
    expect(await configWarning(relayOf(events), OWNER, CATALOG, 'products')).toBeUndefined();
    const revoked = [
      ...events,
      finalizeEvent(buildConfigDelegationRevocation(delegate, NOW - 5), ownerSecret),
    ];
    expect(await configWarning(relayOf(revoked), OWNER, CATALOG, 'products')).toMatch(
      /no published config/,
    );
  });
});
