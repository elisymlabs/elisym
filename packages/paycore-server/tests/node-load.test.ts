import { emptyLedger } from '@merchant-node/ledger';
import { publishTerms } from '@merchant-node/terms';
import { describe, expect, it } from 'vitest';
import {
  StartRefused,
  TERMS_STAND_SECS,
  activePayouts,
  loadStoreBundle,
  storeRails,
} from '../src/node/load';
import { newHolderId } from '../src/state/leases';
import {
  BASE_DEVNET_CAIP19,
  BASE_RPC,
  NOW,
  PAYOUT,
  PRICE,
  RELAY,
  RPCS,
  SOLANA_PAYOUTS,
  SOLANA_RPC,
  TEMPO_DEVNET_CAIP19,
  TEMPO_PAYOUT,
  TEMPO_RPC,
  USDC_DEVNET_CAIP19,
  WEBHOOK_SECRET,
  lease,
  seedStore,
  sellingLedger,
  vault,
} from './helpers/node-store';
import { freshDb } from './pglite-db';

const EVM_PAYOUT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

async function load(options: Parameters<typeof seedStore>[2] = {}, rpcs = RPCS) {
  const db = await freshDb();
  const keys = vault();
  const { owner, store } = await seedStore(db, keys, options);
  const holder = newHolderId();
  const [leased] = await lease(db, holder);
  const bundle = loadStoreBundle(db, keys, owner.pubkey, {
    holder,
    epoch: leased?.epoch ?? 0,
    rpcs,
    inboxRelayAllowlist: [RELAY],
    now: () => NOW,
  });
  return { db, owner, store, bundle };
}

describe('loadStoreBundle', () => {
  it('runs on the operator RPCs only: the store names none', async () => {
    const state = sellingLedger();
    state.terms = publishTerms(
      state.terms,
      { d: 'course-101', caip19: TEMPO_DEVNET_CAIP19, payout: TEMPO_PAYOUT, amount: '1000000' },
      NOW - 3600,
      NOW - 3600,
    );
    state.terms = publishTerms(
      state.terms,
      { d: 'course-101', caip19: BASE_DEVNET_CAIP19, payout: EVM_PAYOUT, amount: '1000000' },
      NOW - 3600,
      NOW - 3600,
    );
    const { bundle, store } = await load({ state, evmCredit: 'safe' });
    const { config, storePubkey, storeSecretKey } = await bundle;
    expect(storePubkey).toBe(store.pubkey);
    expect(storeSecretKey).toEqual(store.secretKey);
    expect(config.rpcUrl).toBe(SOLANA_RPC);
    expect(config.tempo).toEqual({ network: 'moderato', rpcUrl: TEMPO_RPC });
    expect(config.evm).toEqual({ base: { rpcUrl: BASE_RPC, credit: 'safe' } });
    expect(config.feeConfigRpcUrl).toBeUndefined();
    expect(config.inboxRelays).toEqual([RELAY]);
  });

  it('runs without a rail the operator has no RPC for, naming it', async () => {
    const { bundle } = await load({}, { devnet: { tempo: TEMPO_RPC } });
    const loaded = await bundle;
    expect(loaded.rails.solana).toBe(true);
    expect(loaded.config.rpcUrl).toBeUndefined();
    expect(loaded.unavailableRails).toEqual(['solana-devnet']);
    const served = await (await load()).bundle;
    expect(served.unavailableRails).toEqual([]);
  });

  it('takes the active payouts from the ledger, never the draft', async () => {
    const draft = [{ caip19: BASE_DEVNET_CAIP19, address: EVM_PAYOUT, signature: '0xsig' }];
    const { bundle } = await load({ draftPayouts: draft });
    const loaded = await bundle;
    expect(loaded.config.payouts).toEqual(SOLANA_PAYOUTS);
    expect(loaded.rails).toEqual({ solana: true, tempo: false, evm: [] });
    expect(loaded.config.evm).toBeUndefined();
  });

  it('keeps the payout signature and order of the recorded list', () => {
    const state = emptyLedger();
    const payouts = [
      { caip19: TEMPO_DEVNET_CAIP19, address: TEMPO_PAYOUT, signature: 'sig' },
      { caip19: USDC_DEVNET_CAIP19, address: PAYOUT },
    ];
    state.payto = { createdAt: NOW, payouts: JSON.stringify(payouts) };
    expect(activePayouts(state, 'o')).toEqual(payouts);
    expect(JSON.stringify(activePayouts(state, 'o'))).toBe(state.payto.payouts);
    expect(activePayouts(emptyLedger(), 'o')).toEqual([]);
    state.payto = { createdAt: NOW, payouts: '[{"caip19":1}]' };
    expect(() => activePayouts(state, 'o')).toThrow(StartRefused);
  });

  it('keeps the sweep of a chain dropped from the payouts while its terms stand (P10)', () => {
    const tempoOnly = [{ caip19: TEMPO_DEVNET_CAIP19, address: TEMPO_PAYOUT }];
    const solanaTerms = {
      d: 'course-101',
      caip19: USDC_DEVNET_CAIP19,
      payout: PAYOUT,
      amount: PRICE.toString(),
    };
    const standing = [{ terms: solanaTerms, from: NOW - 7200 }];
    expect(storeRails(tempoOnly, standing, 'devnet', NOW).solana).toBe(true);
    const endedLately = [{ terms: solanaTerms, from: NOW - 7200, until: NOW - 100 }];
    expect(storeRails(tempoOnly, endedLately, 'devnet', NOW).solana).toBe(true);
    const endedLongAgo = [
      { terms: solanaTerms, from: NOW - TERMS_STAND_SECS - 7200, until: NOW - TERMS_STAND_SECS },
    ];
    expect(storeRails(tempoOnly, endedLongAgo, 'devnet', NOW)).toEqual({
      solana: false,
      tempo: true,
      evm: [],
    });
    expect(storeRails(SOLANA_PAYOUTS, [], 'mainnet', NOW).solana).toBe(false);
  });

  it('refuses inbox relays outside the allowlist (P7)', async () => {
    const { bundle } = await load({ inboxRelays: [RELAY, 'wss://other.example.com'] });
    await expect(bundle).rejects.toThrow(
      'inbox relays outside the allowlist: wss://other.example.com',
    );
  });

  it('keeps the webhook URL without its secret (no sender), and opens the secret when sealed', async () => {
    const without = await (await load({ webhookUrl: 'https://shop.example.com/hook' })).bundle;
    expect(without.webhook).toBeUndefined();
    expect(without.webhookSecretMissing).toBe(true);
    expect(without.config.webhook).toEqual({ url: 'https://shop.example.com/hook' });
    const withSecret = await load({
      webhookUrl: 'https://shop.example.com/hook',
      webhookSecret: WEBHOOK_SECRET,
    });
    const loaded = await withSecret.bundle;
    expect(loaded.webhook).toEqual({
      url: 'https://shop.example.com/hook',
      secret: WEBHOOK_SECRET,
    });
    expect(loaded.config.webhook).toEqual({ url: 'https://shop.example.com/hook' });
    expect(loaded.webhookSecretMissing).toBe(false);
  });

  it('reads the products and the ledger handle under the lease', async () => {
    const { bundle, db, owner } = await load();
    const loaded = await bundle;
    expect([...loaded.products.keys()]).toEqual(['course-101']);
    expect(loaded.products.get('course-101')).toMatchObject({ priceUsd: '1', onSale: true });
    expect(loaded.handle.rowVersion).toBe(1);
    await loaded.handle.save(loaded.handle.state);
    const [row] = await db.query<{ row_version: number }>(
      'select row_version from ledgers where owner = $1',
      [owner.pubkey],
    );
    expect(row?.row_version).toBe(2);
  });
});
