import { describe, expect, it } from 'vitest';
import { ownEndpointsOf, problemText } from '../../src/cloud/lib/problems';
import { emptyForm } from '../../src/cloud/lib/settings';

/** No path, code or file in a sentence a merchant reads (plan 2.6). */
const JARGON = [/\b[a-z]+\.[a-zA-Z]+\b/, /\b[a-z]+_[a-z_]+\b/, /products\//];

describe('a refusal in words', () => {
  it('names the part of the store it is about, in words, and keeps the line as it came', () => {
    const cases: [string, string | undefined, string][] = [
      ['name: is required', 'name', 'Store name: give your store a name'],
      ['nip05: must be name@domain', 'domain', 'Domain: write only a domain you own'],
      [
        'webhookUrl: must be an https URL on a public host, with no user name or password',
        'webhook',
        'Webhook: use an https address',
      ],
      ['webhook.url: must be a URL', 'webhook', 'Webhook: use an https address'],
      [
        'solana.rpcUrl: the cloud has no RPC configured: name your own',
        'solana',
        'Solana is not available on our side yet',
      ],
      ['rpcUrl: must be a URL', 'solana', 'Solana is not available on our side yet'],
      ['tempo: must be an object (or null for off)', 'tempo', "Tempo: this network's settings"],
      ['tempoRpcUrl: must be a URL', 'tempo', 'Tempo is not available on our side yet'],
      ['evm.base.credit: must be fast or safe', 'base', "Base: this network's settings"],
      ['evm.arbitrum.rpcUrl: must be a URL', 'arbitrum', 'Arbitrum is not available on our side'],
      [
        'solana.rpcUrl: resolves to a private address',
        'solana',
        'Solana is not available on our side yet',
      ],
      ['evm.ethereum: must be an object', 'ethereum', "Ethereum: this network's settings"],
      ['payouts.0.address: not a Solana address', 'payouts', 'Payouts: one of your wallets'],
      ['products/course: priceUsd: must be a decimal', 'products', 'The product "course"'],
      ['products/My_Thing: a product name is lowercase', 'products', 'One of your products'],
      [
        'products/course: image: must be an https:// link to a picture, at most 1,024 characters, such as "https://example.com/photo.jpg"',
        'products',
        'The product "course": its picture link must start with https:// and be at most 1,024 characters.',
      ],
      ['no products: a store sells at least one', 'products', 'Add at least one product'],
      ['relays.0: not a wss URL', undefined, 'The store could not take this change'],
      ['something odd happened', undefined, 'The store could not take this change'],
    ];
    for (const [raw, field, starts] of cases) {
      const shown = problemText(raw);
      expect(shown.field, raw).toBe(field);
      expect(shown.text.startsWith(starts), `${raw} -> ${shown.text}`).toBe(true);
      expect(shown.raw).toBe(raw);
      for (const jargon of JARGON) {
        expect(jargon.test(shown.text), `${shown.text} ~ ${jargon}`).toBe(false);
      }
    }
  });

  it('says to switch to ours only for a network the store has its own endpoint for', () => {
    const line = 'solana.rpcUrl: resolves to a private address';
    const form = emptyForm();
    const own = ownEndpointsOf({
      ...form,
      solana: { on: true, rpcUrl: 'https://rpc.mine.example' },
    });
    expect([...own]).toEqual(['solana']);
    expect(problemText(line, own).text).toBe(
      'Your own Solana endpoint was refused: switch to ours in Settings (Use ours).',
    );
    // Its own endpoint on another network, or none: the endpoint refused is ours.
    expect(problemText(line, new Set(['tempo'])).text).toMatch(
      /^Solana is not available on our side/,
    );
    expect(problemText(line).text).toMatch(/^Solana is not available on our side/);
    // Ours missing is ours, own endpoint or not.
    expect(
      problemText('solana.rpcUrl: the cloud has no RPC configured: name your own', own).text,
    ).toMatch(/^Solana is not available on our side/);
    expect(ownEndpointsOf(undefined).size).toBe(0);
    const evm = {
      ...form.evm,
      base: { on: true, rpcUrl: 'https://b.example', credit: '' as const },
    };
    expect([
      ...ownEndpointsOf({ ...form, evm, tempo: { on: true, rpcUrl: 'https://t.example' } }),
    ]).toEqual(['tempo', 'base']);
  });
});
