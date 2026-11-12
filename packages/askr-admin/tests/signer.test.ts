import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { apiBase } from '../src/constants';
import { syncPollMs } from '../src/lib/deps';
import { type Nip07Provider, extensionSigner } from '../src/lib/signer';
import { NIP44_STUB } from './fakes';

const TEMPLATE: EventTemplate = { kind: 27235, created_at: 1_800_000_000, tags: [], content: '' };

function provider(sign: (template: EventTemplate) => NostrEvent, pubkey: string): Nip07Provider {
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (template) => sign(template),
    nip44: NIP44_STUB,
  };
}

describe('the extension signer', () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);

  it('passes an event the extension signed with the signed-in key', async () => {
    const signer = await extensionSigner(
      provider((template) => finalizeEvent(template, key), pubkey),
    );
    const event = await signer.signEvent(TEMPLATE);
    expect(event.pubkey).toBe(pubkey);
  });

  it('refuses an event by another key', async () => {
    const other = generateSecretKey();
    const signer = await extensionSigner(
      provider((template) => finalizeEvent(template, other), pubkey),
    );
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow('not signed by your key');
  });

  it('refuses an event of another kind', async () => {
    const signer = await extensionSigner(
      provider((template) => finalizeEvent({ ...template, kind: 1 }, key), pubkey),
    );
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow('not signed by your key');
  });

  it('refuses an event whose signature does not verify', async () => {
    const signer = await extensionSigner(
      provider(
        // As an extension hands it over: plain JSON, its content changed after signing.
        (template) =>
          JSON.parse(JSON.stringify({ ...finalizeEvent(template, key), content: 'changed' })),
        pubkey,
      ),
    );
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow('not signed by your key');
  });

  it('refuses a public key that is not 64 hex characters', async () => {
    await expect(
      extensionSigner(provider(() => finalizeEvent(TEMPLATE, key), 'npub1x')),
    ).rejects.toThrow('valid public key');
  });
});

describe('the API base and the sync poll', () => {
  it('is the page origin unless a development override is set', () => {
    expect(apiBase(undefined, 'https://api.askr.elisym.network')).toBe(
      'https://api.askr.elisym.network',
    );
    expect(apiBase('', 'https://admin.example')).toBe('https://admin.example');
    expect(apiBase('http://localhost:8787/', 'https://admin.example')).toBe(
      'http://localhost:8787',
    );
    expect(apiBase()).toBe(window.location.origin);
  });

  it('polls far less often when every read may prompt an extension', () => {
    expect(syncPollMs({ kind: 'secret-key' })).toBe(3_000);
    expect(syncPollMs({ kind: 'extension' })).toBe(30_000);
  });
});
