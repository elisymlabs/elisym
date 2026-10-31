import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  OwnerKey,
  ownerKeyFile,
  ownerKeyFileName,
  parseOwnerKey,
} from '../../src/cloud/lib/owner-key';

const SECRET = generateSecretKey();
const HEX = Array.from(SECRET, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('the owner key', () => {
  it('takes an nsec or 64 hex characters (either case, around spaces), and nothing else', () => {
    for (const text of [nip19.nsecEncode(SECRET), HEX, HEX.toUpperCase(), `  ${HEX}\n`]) {
      expect(parseOwnerKey(text)?.pubkey, text).toBe(getPublicKey(SECRET));
    }
    for (const text of [
      '',
      HEX.slice(1),
      `${HEX}0`,
      nip19.npubEncode(getPublicKey(SECRET)),
      'nsec1notakey',
      '0'.repeat(64),
      'f'.repeat(64),
    ]) {
      expect(parseOwnerKey(text), text).toBeUndefined();
    }
  });

  it('signs as its pubkey, gives its nsec only for the file, and signs nothing once closed', () => {
    const key = OwnerKey.create();
    const event = key.sign({ kind: 1, created_at: 1, tags: [], content: '' });
    expect(event.pubkey).toBe(key.pubkey);
    expect(verifyEvent(event)).toBe(true);
    expect(key.npub).toBe(nip19.npubEncode(key.pubkey));
    const nsec = key.nsec();
    expect(parseOwnerKey(nsec)?.pubkey).toBe(key.pubkey);
    // The secret is not reachable as a property.
    expect(JSON.stringify(key)).not.toContain(nsec);
    expect(Object.values(key)).toEqual([key.pubkey]);
    key.close();
    expect(() => key.sign({ kind: 1, created_at: 1, tags: [], content: '' })).toThrow('closed');
    expect(() => key.nsec()).toThrow('closed');
  });

  it('keeps its own copy of the secret: the caller zeroing its bytes changes nothing', () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const key = new OwnerKey(secret);
    secret.fill(0);
    expect(key.sign({ kind: 1, created_at: 1, tags: [], content: '' }).pubkey).toBe(pubkey);
  });

  it('the key file holds the nsec and names the owner; its name carries only the npub', () => {
    const key = OwnerKey.create();
    const text = ownerKeyFile(key);
    const lines = text.split('\n');
    expect(lines).toContain(key.nsec());
    expect(text).toContain(key.npub);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseOwnerKey(lines.find((line) => line.startsWith('nsec1')) ?? '')?.pubkey).toBe(
      key.pubkey,
    );
    const name = ownerKeyFileName(key);
    expect(name).toBe(`paycore-owner-${key.npub.slice(0, 14)}.txt`);
    expect(name).not.toContain(key.nsec().slice(5, 12));
  });
});
