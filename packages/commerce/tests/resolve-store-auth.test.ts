import { describe, expect, it } from 'vitest';
import { KIND_DELETION, KIND_STORE_AUTH } from '../src/constants';
import {
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  readStoreAuth,
  resolveStoreAuth,
  storeAuthAddress,
} from '../src/events/store-auth';
import { nostrKey, sign } from './fixtures';

const OTHER_KIND = 30497;
const NOW = 1_800_000_000;

describe('resolveStoreAuth', () => {
  const owner = nostrKey();
  const store = nostrKey();

  it('reports none when the owner never authorized the key', () => {
    expect(resolveStoreAuth([], owner.pubkey, store.pubkey, NOW)).toEqual({ status: 'none' });
  });

  it('reads the newest authorization as active', () => {
    const auth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      owner,
    );
    expect(resolveStoreAuth([auth], owner.pubkey, store.pubkey, NOW)).toEqual({
      status: 'active',
      mode: 'hosted',
    });
  });

  it('ignores an authorization signed by someone else', () => {
    const stranger = nostrKey();
    const auth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'hosted', createdAt: NOW - 10 }),
      stranger,
    );
    expect(resolveStoreAuth([auth], owner.pubkey, store.pubkey, NOW)).toEqual({ status: 'none' });
  });

  it('lets a newer revocation win, even dated past the skew window', () => {
    const auth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const revocation = sign(buildStoreRevocationEvent(store.pubkey, NOW + 86_400), owner);
    expect(resolveStoreAuth([auth, revocation], owner.pubkey, store.pubkey, NOW)).toEqual({
      status: 'revoked',
    });
  });

  it('lets a NIP-09 deletion of the address revoke', () => {
    const auth = sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: NOW - 10 }),
      owner,
    );
    const deletion = sign(
      {
        kind: KIND_DELETION,
        created_at: NOW - 5,
        tags: [['a', storeAuthAddress(owner.pubkey, store.pubkey)]],
        content: '',
      },
      owner,
    );
    expect(resolveStoreAuth([auth, deletion], owner.pubkey, store.pubkey, NOW)).toEqual({
      status: 'revoked',
    });
  });

  it('reads another kind only when asked, and never mixes the two', () => {
    const other = sign(
      buildStoreAuthEvent({
        storePubkey: store.pubkey,
        mode: 'self-host',
        createdAt: NOW - 10,
        kind: OTHER_KIND,
      }),
      owner,
    );
    expect(other.kind).toBe(OTHER_KIND);
    expect(resolveStoreAuth([other], owner.pubkey, store.pubkey, NOW)).toEqual({
      status: 'none',
    });
    expect(resolveStoreAuth([other], owner.pubkey, store.pubkey, NOW, OTHER_KIND)).toEqual({
      status: 'active',
      mode: 'self-host',
    });
    expect(readStoreAuth(other, store.pubkey, NOW)).toEqual({ status: 'malformed' });
  });

  it('revokes another kind only through that kind', () => {
    const other = sign(
      buildStoreAuthEvent({
        storePubkey: store.pubkey,
        mode: 'self-host',
        createdAt: NOW - 10,
        kind: OTHER_KIND,
      }),
      owner,
    );
    const payCoreRevocation = sign(buildStoreRevocationEvent(store.pubkey, NOW - 5), owner);
    expect(payCoreRevocation.kind).toBe(KIND_STORE_AUTH);
    expect(
      resolveStoreAuth([other, payCoreRevocation], owner.pubkey, store.pubkey, NOW, OTHER_KIND),
    ).toEqual({ status: 'active', mode: 'self-host' });
    const otherRevocation = sign(
      buildStoreRevocationEvent(store.pubkey, NOW - 5, OTHER_KIND),
      owner,
    );
    expect(
      resolveStoreAuth([other, otherRevocation], owner.pubkey, store.pubkey, NOW, OTHER_KIND),
    ).toEqual({ status: 'revoked' });
    expect(storeAuthAddress(owner.pubkey, store.pubkey, OTHER_KIND)).toBe(
      `${OTHER_KIND}:${owner.pubkey}:${store.pubkey}`,
    );
  });

  it('reports a malformed newest word so a caller can fail closed', () => {
    const malformed = sign(
      {
        kind: KIND_STORE_AUTH,
        created_at: NOW - 1,
        tags: [
          ['d', store.pubkey],
          ['p', store.pubkey],
          ['mode', 'hosted'],
          ['mode', 'self-host'],
        ],
        content: '',
      },
      owner,
    );
    expect(resolveStoreAuth([malformed], owner.pubkey, store.pubkey, NOW)).toEqual({
      status: 'malformed',
    });
  });
});
