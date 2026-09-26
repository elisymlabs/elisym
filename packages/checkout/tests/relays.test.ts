import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS, STORE_RELAY_CAP } from '../src/core/constants';
import { normalizeRelayUrl, readRelays, storeRelays, uniqueRelays } from '../src/core/relays';

describe('normalizeRelayUrl', () => {
  it('keeps a wss relay on a public name, in one spelling', () => {
    expect(normalizeRelayUrl('wss://Relay.Example.com/')).toBe('wss://relay.example.com');
    expect(normalizeRelayUrl('wss://relay.example.com/inbox/')).toBe(
      'wss://relay.example.com/inbox',
    );
    expect(normalizeRelayUrl('wss://relay.example.com:444')).toBe('wss://relay.example.com:444');
    expect(normalizeRelayUrl('wss://relay.example.com//inbox//')).toBe(
      'wss://relay.example.com/inbox',
    );
  });

  it('refuses anything the store could aim at a private host or smuggle state through', () => {
    for (const value of [
      'ws://relay.example.com',
      'https://relay.example.com',
      'wss://localhost',
      'wss://127.0.0.1',
      'wss://[::1]',
      'wss://relay.local',
      'wss://10.0.0.1',
      'wss://user:pass@relay.example.com',
      'wss://user@relay.example.com',
      'wss://:pass@relay.example.com',
      'wss://relay.example.com/?token=1',
      'wss://relay.example.com/#x',
      'not a url',
      '',
      `wss://relay.example.com/${'a'.repeat(300)}`,
      42,
      undefined,
    ]) {
      expect(normalizeRelayUrl(value)).toBeUndefined();
    }
  });
});

describe('store relay selection', () => {
  const inbox = Array.from({ length: 10 }, (_, index) => `wss://inbox${index}.example.com`);

  it('puts the current inbox first, then acknowledged relays, then hints, capped', () => {
    const relays = storeRelays({
      inbox: inbox.slice(0, 3),
      acknowledged: ['wss://old.example.com', 'wss://inbox0.example.com'],
      hints: ['wss://hint.example.com'],
    });
    expect(relays).toEqual([
      'wss://inbox0.example.com',
      'wss://inbox1.example.com',
      'wss://inbox2.example.com',
      'wss://old.example.com',
      'wss://hint.example.com',
    ]);
  });

  it('never lets hints crowd out the inbox', () => {
    const relays = storeRelays({ inbox, hints: ['wss://hint.example.com'] });
    expect(relays).toHaveLength(STORE_RELAY_CAP);
    expect(relays).not.toContain('wss://hint.example.com');
  });

  it('always reads from the default relays, outside the cap', () => {
    const hints = Array.from({ length: 12 }, (_, index) => `wss://hint${index}.example.com`);
    const relays = readRelays({ hints });
    expect(relays.slice(0, DEFAULT_RELAYS.length)).toEqual(DEFAULT_RELAYS);
    expect(relays).toHaveLength(DEFAULT_RELAYS.length + STORE_RELAY_CAP);
  });

  it('drops duplicates and unusable entries', () => {
    expect(
      uniqueRelays(['wss://a.example.com', 'wss://A.example.com/', 'ws://b.example.com', null]),
    ).toEqual(['wss://a.example.com']);
  });
});
