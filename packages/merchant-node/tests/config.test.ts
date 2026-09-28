import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configProblems, configTemplate, loadConfig } from '../src/config';
import { PAYOUT, USDC_DEVNET_CAIP19 } from './fixtures';

const MAINNET_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEMPO_USDC = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';

function valid() {
  return {
    ...configTemplate('devnet'),
    payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT as string }],
  };
}

describe('the merchant config', () => {
  it('accepts a filled-in template', () => {
    expect(configProblems(valid())).toEqual([]);
    expect(
      configProblems({
        ...valid(),
        network: 'mainnet',
        payouts: [{ caip19: MAINNET_USDC, address: PAYOUT }],
      }),
    ).toEqual([]);
  });

  it('refuses the template as written: the payout address is a placeholder', () => {
    expect(configProblems(configTemplate('devnet'))).toEqual([
      'payouts.0.address: is not a Solana address',
    ]);
  });

  it('refuses a payout this node cannot verify', () => {
    expect(
      configProblems({ ...valid(), payouts: [{ caip19: MAINNET_USDC, address: PAYOUT }] }),
    ).toEqual(['payouts.0.caip19: is on mainnet, the node runs on devnet']);
    expect(
      configProblems({ ...valid(), payouts: [{ caip19: TEMPO_USDC, address: PAYOUT }] }),
    ).toEqual(['payouts.0.caip19: must be a Solana coin this node can verify']);
    const twice = { caip19: USDC_DEVNET_CAIP19, address: PAYOUT as string };
    expect(configProblems({ ...valid(), payouts: [twice, twice] })).toEqual([
      'payouts.1.caip19: is listed twice: one payout per coin',
    ]);
    expect(configProblems({ ...valid(), payouts: [] })).toHaveLength(1);
  });

  it('refuses an inbox relay the checkout never contacts, or one listed twice', () => {
    for (const relay of ['wss://10.0.0.5', 'wss://127.0.0.1:7777', 'wss://localhost']) {
      expect(configProblems({ ...valid(), inboxRelays: [relay] })).toHaveLength(1);
    }
    expect(
      configProblems({ ...valid(), inboxRelays: ['wss://nos.lol', 'wss://nos.lol/'] }),
    ).toEqual(['inboxRelays.1: is listed twice']);
    // A local relay for tests.
    expect(configProblems({ ...valid(), inboxRelays: ['ws://localhost:7777'] })).toEqual([]);
  });

  it('refuses insecure or malformed endpoints', () => {
    expect(configProblems({ ...valid(), rpcUrl: 'http://rpc.example.com' })).toHaveLength(1);
    expect(configProblems({ ...valid(), rpcUrl: 'http://127.0.0.1:8899' })).toEqual([]);
    expect(configProblems({ ...valid(), inboxRelays: ['ws://relay.example.com'] })).toHaveLength(1);
    expect(configProblems({ ...valid(), inboxRelays: [] })).toHaveLength(1);
    expect(
      configProblems({
        ...valid(),
        inboxRelays: Array.from({ length: 6 }, (_, index) => `wss://r${index}.example.com`),
      }),
    ).toHaveLength(1);
  });

  it('refuses a price, product or delivery the store cannot sell', () => {
    const product = valid().product;
    for (const priceUsd of ['0', '-1', '1e3', '1.1234567', 'ten']) {
      expect(configProblems({ ...valid(), product: { ...product, priceUsd } })).toHaveLength(1);
    }
    expect(configProblems({ ...valid(), product: { ...product, d: 'has space' } })).toHaveLength(1);
    expect(
      configProblems({
        ...valid(),
        product: { ...product, delivery: { method: 'email', value: 'x' } },
      }),
    ).toHaveLength(1);
    expect(
      configProblems({
        ...valid(),
        product: { ...product, delivery: { method: 'access', value: '' } },
      }),
    ).toHaveLength(1);
    expect(
      configProblems({
        ...valid(),
        product: { ...product, delivery: { method: 'access', value: 'x'.repeat(1025) } },
      }),
    ).toHaveLength(1);
  });

  it('refuses a coin that cannot be paid a USD price, and the name "owner"', () => {
    const lsm =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
    expect(
      configProblems({
        ...valid(),
        network: 'mainnet',
        payouts: [{ caip19: lsm, address: PAYOUT }],
      }),
    ).toEqual(['payouts.0.caip19: LSM cannot be paid a USD price']);
    expect(configProblems({ ...valid(), nip05: 'owner@shop.example' })).toHaveLength(1);
  });

  it('refuses unknown fields and a bad nip05', () => {
    expect(configProblems({ ...valid(), delivery: {} })).toHaveLength(1);
    expect(configProblems({ ...valid(), nip05: 'not a nip05' })).toHaveLength(1);
    expect(configProblems({ ...valid(), nip05: '_@shop.example' })).toEqual([]);
  });

  it('loads inbox relays in the one spelling the checkout uses', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'merchant-config-')), 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...valid(),
        inboxRelays: [
          'wss://Relay.Elisym.Network/',
          'wss://nos.lol//inbox/',
          'ws://localhost:7777/',
        ],
      }),
    );
    expect(loadConfig(path).inboxRelays).toEqual([
      'wss://relay.elisym.network',
      'wss://nos.lol/inbox',
      'ws://localhost:7777/',
    ]);
  });
});
