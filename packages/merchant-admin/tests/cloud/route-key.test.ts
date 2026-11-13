import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { OwnerKey } from '../../src/cloud/lib/owner-key';
import { type RouteDeps, dropRouted, routeKey } from '../../src/cloud/lib/route-key';
import { type StoreKey, parseStoreKey } from '../../src/lib/core';

function storeKey(): StoreKey {
  const secret = generateSecretKey();
  const key = parseStoreKey(Buffer.from(secret).toString('hex'));
  if (key === undefined) {
    throw new Error('no key');
  }
  return key;
}

const zeroed = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

function deps(
  answer: { status: number; body: unknown },
  relays: () => Promise<boolean>,
): RouteDeps & { signers: OwnerKey[] } {
  const signers: OwnerKey[] = [];
  return {
    signers,
    askOwner: async (owner) => {
      signers.push(owner);
      return answer;
    },
    relaysShowAStore: relays,
  };
}

describe('routing one key, with what it holds', () => {
  it('hands a self-hosted store its key live, and closes the owner copy', async () => {
    const key = storeKey();
    const close = vi.spyOn(OwnerKey.prototype, 'close');
    const routed = await routeKey(
      key,
      deps({ status: 0, body: { error: 'unreachable' } }, async () => true),
    );
    expect(routed).toEqual({ where: 'self-hosted', key });
    expect(zeroed(key.secretKey)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('hands a cloud store the owner copy live, and zeroes the store key', async () => {
    for (const [answer, where] of [
      [{ status: 200, body: { tenantId: 'aaaaaaaaaaaa' } }, 'cloud'],
      [{ status: 403, body: { error: 'forbidden' } }, 'cloud'],
      [{ status: 200, body: { tenantId: null } }, 'cloud-none'],
    ] as const) {
      const key = storeKey();
      const pubkey = key.pubkey;
      const used = deps(answer, async () => false);
      const routed = await routeKey(key, used);
      expect(routed.where).toBe(where);
      expect(zeroed(key.secretKey)).toBe(true);
      if (routed.where !== 'cloud' && routed.where !== 'cloud-none') {
        throw new Error('not a cloud route');
      }
      expect(routed.owner).toBe(used.signers[0]);
      expect(routed.owner.pubkey).toBe(pubkey);
      // Live: it still signs.
      expect(routed.owner.sign({ kind: 1, created_at: 0, tags: [], content: '' }).pubkey).toBe(
        pubkey,
      );
    }
  });

  it('keeps nothing when nothing opens', async () => {
    const key = storeKey();
    const used = deps({ status: 503, body: { error: 'internal' } }, async () => false);
    expect(await routeKey(key, used)).toEqual({ where: 'unreachable' });
    expect(zeroed(key.secretKey)).toBe(true);
    expect(() => used.signers[0]?.nsec()).toThrow('closed');
  });

  it('counts a failed relay read as no store', async () => {
    const key = storeKey();
    const used = deps({ status: 0, body: {} }, () => Promise.reject(new Error('down')));
    expect(await routeKey(key, used)).toEqual({ where: 'unreachable' });
  });

  it('counts a request that throws as no answer, as a relay read that throws as no store', async () => {
    const throwers: RouteDeps['askOwner'][] = [
      () => Promise.reject(new Error('down')),
      () => {
        throw new TypeError('no AbortSignal.timeout');
      },
    ];
    for (const askOwner of throwers) {
      const found = storeKey();
      expect(await routeKey(found, { askOwner, relaysShowAStore: async () => true })).toEqual({
        where: 'self-hosted',
        key: found,
      });
      const none = storeKey();
      expect(
        await routeKey(none, {
          askOwner,
          relaysShowAStore: () => {
            throw new Error('no relays');
          },
        }),
      ).toEqual({ where: 'unreachable' });
      expect(zeroed(none.secretKey)).toBe(true);
    }
  });

  it('does not wait for the relays where the cloud decides alone', async () => {
    const key = storeKey();
    const used = deps(
      { status: 200, body: { tenantId: 'aaaaaaaaaaaa' } },
      () => new Promise<boolean>(() => undefined),
    );
    expect((await routeKey(key, used)).where).toBe('cloud');
  });

  it('a dropped route zeroes the copy it held', async () => {
    const store = storeKey();
    dropRouted({ where: 'self-hosted', key: store });
    expect(zeroed(store.secretKey)).toBe(true);
    const owner = OwnerKey.create();
    dropRouted({ where: 'cloud', owner });
    expect(() => owner.nsec()).toThrow('closed');
    dropRouted({ where: 'unreachable' });
  });
});
