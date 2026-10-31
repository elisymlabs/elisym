import { describe, expect, it } from 'vitest';
import { problemText } from '../../src/cloud/lib/problems';

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
        'Solana: we could not reach this network',
      ],
      ['rpcUrl: must be a URL', 'solana', 'Solana: we could not reach this network'],
      ['tempo: must be an object (or null for off)', 'tempo', "Tempo: this network's settings"],
      ['tempoRpcUrl: must be a URL', 'tempo', 'Tempo: we could not reach this network'],
      ['evm.base.credit: must be fast or safe', 'base', "Base: this network's settings"],
      ['evm.arbitrum.rpcUrl: must be a URL', 'arbitrum', 'Arbitrum: we could not reach'],
      ['evm.ethereum: must be an object', 'ethereum', "Ethereum: this network's settings"],
      ['payouts.0.address: not a Solana address', 'payouts', 'Payouts: one of your wallets'],
      ['products/course: priceUsd: must be a decimal', 'products', 'The product "course"'],
      ['products/My_Thing: a product name is lowercase', 'products', 'One of your products'],
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
});
