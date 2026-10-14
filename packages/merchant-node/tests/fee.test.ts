/**
 * The fee side of the node that is not the paid rule itself: the ledger
 * version that locks older nodes out, the known treasuries and how they are
 * read, the fee declaration, the profile warning, and what the records say.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStoreProfile, unwrapOrderMessage } from '@elisym/commerce';
import type { ProtocolConfig } from '@elisym/pay-core';
import { type Rpc, type SolanaRpcApi, address } from '@solana/kit';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Credit, type OrderRow, totalsOf } from '../src/admin/history';
import { profileFeeSupport } from '../src/checks';
import { configProblems, hasSolanaRail, loadConfig } from '../src/config';
import { FEE_CONFIG_READ_TIMEOUT_MS } from '../src/constants';
import {
  TREASURY_RETENTION_SECS,
  TreasuryReader,
  feeConfigRpcUrl,
  feeDeclaration,
  hasKnownTreasuries,
  knownTreasuries,
  paymentFloor,
  profileFeeWarning,
  recordTreasuryRead,
} from '../src/fee';
import { applyHandAnswer } from '../src/hand';
import {
  type LedgerState,
  type MerchantOrder,
  LEDGER_VERSION,
  PRE_FEE_LEDGER_VERSION,
  emptyLedger,
  loadLedger,
  markFeeUnresolved,
  openLedger,
  openLedgerForUpgrade,
  pruneExpiredOrders,
  recordPayment,
  saveLedger,
} from '../src/ledger';
import { buildDeliveryReply } from '../src/reply';
import { buildStoreWideEvents } from '../src/store-events';
import { orderLines } from '../src/webhook-commands';
import { PAYOUT, T0, USDC_DEVNET_CAIP19, key, signatureOf } from './fixtures';

const NOW = T0 + 1000;
const SOL_TREASURY = address('GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy');
const OLD_SOL_TREASURY = address('HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg');
const EVM_TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1zcqDFVGPZXAh';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'merchant-fee-')), 'ledger.json');
}

/** The ledger a node before fee support wrote: version 3, none of the new fields. */
function writeV3(path: string, change: (state: Record<string, unknown>) => void = () => {}): void {
  const { treasuries: _treasuries, unresolvedPayments: _unresolved, ...rest } = emptyLedger();
  const state: Record<string, unknown> = { ...rest, version: PRE_FEE_LEDGER_VERSION };
  change(state);
  writeFileSync(path, JSON.stringify(state));
}

function versionOnDisk(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: unknown }).version;
}

/** The check every merchant-node before fee support runs on its ledger (`ledger.ts` of 0.9.1). */
function releasedLoad(path: string): void {
  const version: unknown = (JSON.parse(readFileSync(path, 'utf8')) as { version: unknown }).version;
  if (version !== 3) {
    throw new Error(`Unknown ledger version in ${path}`);
  }
}

function order(key = 'k', change: Partial<MerchantOrder> = {}): MerchantOrder {
  return {
    key,
    buyerPubkey: 'b'.repeat(64),
    orderId: 'b3a7c2d4-0000-4000-8000-000000000001',
    rumorId: 'r',
    createdAt: T0,
    reference: 'Ref',
    product: `30402:${'s'.repeat(64)}:course-101`,
    reportedTxs: [],
    ...change,
  };
}

describe('ledger version 4', () => {
  it('reads a version 3 ledger converted in memory, and says what the disk held', () => {
    const path = scratch();
    writeV3(path);
    const loaded = loadLedger(path);
    expect(loaded.read).toBe(3);
    expect(loaded.state.version).toBe(4);
    expect(loaded.state.treasuries).toEqual({});
    expect(loaded.state.unresolvedPayments).toEqual([]);
    // Reading converts nothing on disk.
    expect(versionOnDisk(path)).toBe(3);
    saveLedger(path, loaded.state);
    expect(loadLedger(path).read).toBe(LEDGER_VERSION);
    expect(loadLedger(scratch()).read).toBe('missing');
  });

  it('setup and run save the conversion at once, a missing ledger too', () => {
    const path = scratch();
    writeV3(path);
    openLedgerForUpgrade(path, () => undefined);
    expect(versionOnDisk(path)).toBe(4);
    const fresh = scratch();
    openLedgerForUpgrade(fresh, () => undefined);
    expect(versionOnDisk(fresh)).toBe(4);
  });

  it('writes nothing when the refusal check stops the command', () => {
    const path = scratch();
    writeV3(path);
    expect(() =>
      openLedgerForUpgrade(path, () => {
        throw new Error('lost history');
      }),
    ).toThrow('lost history');
    expect(versionOnDisk(path)).toBe(3);
  });

  it('an older node refuses a v4 ledger; this one refuses nothing it wrote', () => {
    const path = scratch();
    saveLedger(path, emptyLedger());
    expect(() => releasedLoad(path)).toThrow('Unknown ledger version');
    expect(() => openLedger(path)).not.toThrow();
  });

  it('every other command refuses a version 3 ledger with the upgrade hint', () => {
    const path = scratch();
    writeV3(path);
    expect(() => openLedger(path)).toThrow(
      /run `elisym-merchant setup` or `run` once after upgrading/,
    );
    expect(versionOnDisk(path)).toBe(3);
    // A first run (no ledger) is not refused.
    expect(() => openLedger(scratch())).not.toThrow();
  });

  it('still refuses a 0.7 ledger and an unknown version', () => {
    const path = scratch();
    for (const version of [1, 2]) {
      writeV3(path, (state) => {
        state.version = version;
      });
      expect(() => loadLedger(path)).toThrow('create a new home with init');
    }
    writeV3(path, (state) => {
      state.version = 5;
    });
    expect(() => loadLedger(path)).toThrow('Unknown ledger version');
  });
});

describe('known treasuries', () => {
  it('the floor is the price less a fee at the 10% cap, rounded for the fee', () => {
    expect(paymentFloor(1_000_000n)).toBe(900_000n);
    expect(paymentFloor(11n)).toBe(9n);
    expect(paymentFloor(10n)).toBe(9n);
    expect(paymentFloor(1n)).toBe(0n);
  });

  it('records every read, whatever the rate, and keeps an address the retention window', () => {
    const state = emptyLedger();
    expect(hasKnownTreasuries(state, 'devnet')).toBe(false);
    recordTreasuryRead(
      state,
      'devnet',
      { treasury: OLD_SOL_TREASURY, evmTreasury: EVM_TREASURY },
      NOW,
    );
    recordTreasuryRead(
      state,
      'devnet',
      { treasury: SOL_TREASURY, evmTreasury: undefined },
      NOW + 10,
    );
    expect(hasKnownTreasuries(state, 'devnet')).toBe(true);
    expect(hasKnownTreasuries(state, 'mainnet')).toBe(false);
    expect(knownTreasuries(state, 'devnet', 'solana', NOW + 10)).toEqual([
      OLD_SOL_TREASURY,
      SOL_TREASURY,
    ]);
    // The edge: exactly the window is kept, a second more is dropped.
    expect(knownTreasuries(state, 'devnet', 'solana', NOW + TREASURY_RETENTION_SECS)).toContain(
      OLD_SOL_TREASURY,
    );
    expect(
      knownTreasuries(state, 'devnet', 'solana', NOW + TREASURY_RETENTION_SECS + 1),
    ).not.toContain(OLD_SOL_TREASURY);
    expect(knownTreasuries(state, 'devnet', 'evm', NOW + TREASURY_RETENTION_SECS)).toEqual([
      EVM_TREASURY,
    ]);
    expect(knownTreasuries(state, 'devnet', 'evm', NOW + TREASURY_RETENTION_SECS + 1)).toEqual([]);
    expect(knownTreasuries(state, 'mainnet', 'solana', NOW)).toEqual([]);
  });

  it('keeps the last read treasuries whatever their age, and forgets old ones on a read', () => {
    const state = emptyLedger();
    recordTreasuryRead(
      state,
      'devnet',
      { treasury: OLD_SOL_TREASURY, evmTreasury: EVM_TREASURY },
      NOW,
    );
    // A config RPC down for ten days: the last read still counts.
    const later = NOW + 10 * 86_400;
    expect(knownTreasuries(state, 'devnet', 'solana', later)).toEqual([OLD_SOL_TREASURY]);
    expect(knownTreasuries(state, 'devnet', 'evm', later)).toEqual([EVM_TREASURY]);
    // A read exactly the window later still keeps the old address; one second more forgets it.
    const edge = emptyLedger();
    recordTreasuryRead(edge, 'devnet', { treasury: OLD_SOL_TREASURY, evmTreasury: undefined }, NOW);
    recordTreasuryRead(
      edge,
      'devnet',
      { treasury: SOL_TREASURY, evmTreasury: undefined },
      NOW + TREASURY_RETENTION_SECS,
    );
    expect(Object.keys(edge.treasuries.devnet?.solana ?? {})).toEqual([
      OLD_SOL_TREASURY,
      SOL_TREASURY,
    ]);
    recordTreasuryRead(
      edge,
      'devnet',
      { treasury: SOL_TREASURY, evmTreasury: undefined },
      NOW + TREASURY_RETENTION_SECS + 1,
    );
    expect(Object.keys(edge.treasuries.devnet?.solana ?? {})).toEqual([SOL_TREASURY]);
    recordTreasuryRead(state, 'devnet', { treasury: SOL_TREASURY, evmTreasury: undefined }, later);
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: later });
    expect(state.treasuries.devnet?.evm).toEqual({});
    expect(state.treasuries.devnet?.latest).toEqual({ solana: SOL_TREASURY });
  });
});

/** A config RPC answering `genesis`, counting what it is asked. */
function configRpc(genesis: string | Error) {
  const asked = { genesis: 0 };
  const rpc = {
    getGenesisHash: () => ({
      send: async () => {
        asked.genesis += 1;
        if (genesis instanceof Error) {
          throw genesis;
        }
        return genesis;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, asked };
}

function configRead(source: 'onchain' | 'cache', feeBps = 300): ProtocolConfig {
  return {
    programId: SOL_TREASURY,
    feeBps,
    treasury: SOL_TREASURY,
    admin: SOL_TREASURY,
    pendingAdmin: null,
    paused: false,
    version: 1,
    evmTreasury: EVM_TREASURY,
    source,
  } as unknown as ProtocolConfig;
}

describe('the treasury reader', () => {
  it('reads fresh and records only after the genesis hash matched, and checks it once', async () => {
    const { rpc, asked } = configRpc(DEVNET_GENESIS);
    const calls: unknown[] = [];
    const reader = new TreasuryReader(rpc, 'devnet', async (...args) => {
      calls.push(args[3]);
      return configRead('onchain');
    });
    const state = emptyLedger();
    expect(await reader.refresh(state, NOW)).toEqual({ kind: 'read', feeBps: 300 });
    expect(await reader.refresh(state, NOW + 60)).toEqual({ kind: 'read', feeBps: 300 });
    expect(asked.genesis).toBe(1);
    expect(calls).toEqual([{ forceRefresh: true }, { forceRefresh: true }]);
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW + 60 });
  });

  it('records nothing on another cluster, reads no config, and says so every time', async () => {
    const { rpc, asked } = configRpc(MAINNET_GENESIS);
    let reads = 0;
    const reader = new TreasuryReader(rpc, 'devnet', async () => {
      reads += 1;
      return configRead('onchain');
    });
    const state = emptyLedger();
    for (const at of [NOW, NOW + 60]) {
      expect(await reader.refresh(state, at)).toMatchObject({ kind: 'wrong_cluster' });
    }
    expect(asked.genesis).toBe(2);
    expect(reads).toBe(0);
    expect(state.treasuries).toEqual({});
  });

  it('an endpoint down at start is checked on the first contact that answers', async () => {
    let genesis: string | Error = new Error('connect ECONNREFUSED');
    const rpc = {
      getGenesisHash: () => ({
        send: async () => {
          if (genesis instanceof Error) {
            throw genesis;
          }
          return genesis;
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    let reads = 0;
    const reader = new TreasuryReader(rpc, 'devnet', async () => {
      reads += 1;
      return configRead('onchain');
    });
    const state = emptyLedger();
    expect(await reader.refresh(state, NOW)).toMatchObject({ kind: 'unreachable' });
    expect(reads).toBe(0);
    genesis = MAINNET_GENESIS;
    expect(await reader.refresh(state, NOW + 60)).toMatchObject({ kind: 'wrong_cluster' });
    expect(reads).toBe(0);
    genesis = DEVNET_GENESIS;
    expect(await reader.refresh(state, NOW + 120)).toEqual({ kind: 'read', feeBps: 300 });
    expect(reads).toBe(1);
  });

  it('a cached answer or a failed read bumps no last-seen', async () => {
    const { rpc } = configRpc(DEVNET_GENESIS);
    let answer: () => ProtocolConfig = () => configRead('onchain');
    const reader = new TreasuryReader(rpc, 'devnet', async () => answer());
    const state = emptyLedger();
    await reader.refresh(state, NOW);
    answer = () => configRead('cache');
    expect(await reader.refresh(state, NOW + 60)).toMatchObject({ kind: 'unreachable' });
    answer = () => {
      throw new Error('rpc down');
    };
    expect(await reader.refresh(state, NOW + 120)).toMatchObject({
      kind: 'unreachable',
      problem: 'rpc down',
    });
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW });
  });

  it('records the treasuries at a fee of 0 too', async () => {
    const { rpc } = configRpc(DEVNET_GENESIS);
    const reader = new TreasuryReader(rpc, 'devnet', async () => configRead('onchain', 0));
    const state = emptyLedger();
    expect(await reader.refresh(state, NOW)).toEqual({ kind: 'read', feeBps: 0 });
    expect(knownTreasuries(state, 'devnet', 'evm', NOW)).toEqual([EVM_TREASURY]);
  });
});

describe('the treasury reader deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a genesis check that never answers is unreachable after FEE_CONFIG_READ_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const rpc = {
      getGenesisHash: () => ({ send: () => new Promise<string>(() => {}) }),
    } as unknown as Rpc<SolanaRpcApi>;
    const reader = new TreasuryReader(rpc, 'devnet', async () => configRead('onchain'));
    let answer: unknown;
    void reader.refresh(emptyLedger(), NOW).then((result) => {
      answer = result;
    });
    await vi.advanceTimersByTimeAsync(FEE_CONFIG_READ_TIMEOUT_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toMatchObject({ kind: 'unreachable', problem: /did not answer within/ });
  });

  it('a config read answered past the deadline is unreachable and records nothing', async () => {
    const { rpc } = configRpc(DEVNET_GENESIS);
    let answerLate: (config: ProtocolConfig) => void = () => {};
    const reader = new TreasuryReader(
      rpc,
      'devnet',
      () =>
        new Promise<ProtocolConfig>((resolve) => {
          answerLate = resolve;
        }),
      20,
    );
    const state = emptyLedger();
    expect(await reader.refresh(state, NOW)).toMatchObject({
      kind: 'unreachable',
      problem: /did not answer within 20 ms/,
    });
    answerLate(configRead('onchain'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.treasuries).toEqual({});
  });

  it('waits ten seconds by default: a config read answered after 5 s is recorded', async () => {
    expect(FEE_CONFIG_READ_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    const { rpc } = configRpc(DEVNET_GENESIS);
    const reader = new TreasuryReader(
      rpc,
      'devnet',
      () =>
        new Promise<ProtocolConfig>((resolve) => {
          setTimeout(() => resolve(configRead('onchain')), 5_000);
        }),
    );
    const state = emptyLedger();
    let answer: unknown;
    void reader.refresh(state, NOW).then((result) => {
      answer = result;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ kind: 'read', feeBps: 300 });
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW });
  });

  it('a read inside the deadline is recorded', async () => {
    const { rpc } = configRpc(DEVNET_GENESIS);
    const reader = new TreasuryReader(rpc, 'devnet', async () => configRead('onchain'), 1_000);
    const state = emptyLedger();
    expect(await reader.refresh(state, NOW)).toEqual({ kind: 'read', feeBps: 300 });
    expect(state.treasuries.devnet?.solana).toEqual({ [SOL_TREASURY]: NOW });
  });
});

describe('the fee declaration of setup', () => {
  it('refuses another cluster before anything is published', () => {
    expect(() =>
      feeDeclaration(emptyLedger(), 'devnet', { kind: 'wrong_cluster', problem: 'mainnet' }),
    ).toThrow(/nothing was published/);
  });

  it('a home that never read the config declares nothing, loudly', () => {
    const declaration = feeDeclaration(emptyLedger(), 'devnet', {
      kind: 'unreachable',
      problem: 'down',
    });
    expect(declaration.declare).toBe(false);
    expect(declaration.warning).toMatch(/WITHOUT protocol-fee support/);
  });

  it('persisted treasuries keep the declaration through an outage; a read declares', () => {
    const state = emptyLedger();
    recordTreasuryRead(state, 'devnet', { treasury: SOL_TREASURY, evmTreasury: undefined }, NOW);
    const outage = feeDeclaration(state, 'devnet', { kind: 'unreachable', problem: 'down' });
    expect(outage.declare).toBe(true);
    expect(outage.warning).toMatch(/read before/);
    expect(feeDeclaration(state, 'devnet', { kind: 'read', feeBps: 0 })).toEqual({
      declare: true,
    });
    // Another network's treasuries are no proof for this one.
    expect(feeDeclaration(state, 'mainnet', { kind: 'unreachable', problem: 'x' }).declare).toBe(
      false,
    );
  });

  it('the profile carries the fee tag exactly when declared', () => {
    const keys = { storeSecretKey: generateSecretKey(), ownerSecretKey: generateSecretKey() };
    const config = {
      name: 'Shop',
      payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      inboxRelays: ['wss://inbox'],
    };
    const profileOf = (declare: boolean) => {
      const profile = buildStoreWideEvents(config, keys, T0, T0, declare).others.find(
        (event) => event.kind === 0,
      );
      if (profile === undefined) {
        throw new Error('no profile');
      }
      return profile;
    };
    expect(profileOf(true).tags).toContainEqual(['fee', '1']);
    expect(parseStoreProfile(profileOf(true))?.feeSupport).toBe(true);
    expect(profileOf(false).tags.some((tag) => tag[0] === 'fee')).toBe(false);
  });
});

describe('the profile warning of run and check', () => {
  const profile = (tags: string[][]): NostrEvent =>
    finalizeEvent({ kind: 0, created_at: T0, tags, content: '{}' }, generateSecretKey());

  it('warns when a served profile lacks the fee tag, louder while the fee is above 0', () => {
    const tagless = profileFeeSupport([
      { listings: [], payoutList: undefined, inboxList: undefined, profile: profile([]) },
    ]);
    expect(tagless).toEqual({ found: true, feeSupport: false });
    expect(profileFeeWarning(tagless.found, tagless.feeSupport, 0)).toMatch(/re-run setup/);
    expect(profileFeeWarning(tagless.found, tagless.feeSupport, 0)).not.toMatch(/bps NOW/);
    expect(profileFeeWarning(tagless.found, tagless.feeSupport, 1)).toMatch(/1 bps NOW/);
    expect(profileFeeWarning(tagless.found, tagless.feeSupport, undefined)).not.toMatch(/NOW/);
  });

  it('says nothing for a tagged profile, or when none is served', () => {
    const tagged = profileFeeSupport([
      {
        listings: [],
        payoutList: undefined,
        inboxList: undefined,
        profile: profile([['fee', '1']]),
      },
    ]);
    expect(tagged).toEqual({ found: true, feeSupport: true });
    expect(profileFeeWarning(tagged.found, tagged.feeSupport, 300)).toBeUndefined();
    const none = profileFeeSupport([{ listings: [], payoutList: undefined, inboxList: undefined }]);
    expect(none.found).toBe(false);
    expect(profileFeeWarning(none.found, none.feeSupport, 300)).toBeUndefined();
  });

  it('one view without the tag is enough to warn', () => {
    const views = [
      {
        listings: [],
        payoutList: undefined,
        inboxList: undefined,
        profile: profile([['fee', '1']]),
      },
      { listings: [], payoutList: undefined, inboxList: undefined, profile: profile([]) },
    ];
    expect(profileFeeSupport(views)).toEqual({ found: true, feeSupport: false });
  });
});

describe('the fee config RPC', () => {
  const base = {
    name: 'Shop',
    inboxRelays: ['wss://relay.elisym.network'],
    payouts: [
      {
        caip19: 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000',
        address: '0x5696da2cecea22f127948458382ac2c59bc8e4bb',
      },
    ],
    tempo: { network: 'moderato' },
    network: 'devnet',
  };

  it('is its own setting and switches on no Solana payments', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'merchant-fee-config-')), 'config.json');
    writeFileSync(path, JSON.stringify({ ...base, feeConfigRpcUrl: 'https://rpc.example' }));
    const config = loadConfig(path);
    expect(config.feeConfigRpcUrl).toBe('https://rpc.example');
    expect(hasSolanaRail(config)).toBe(false);
    expect(feeConfigRpcUrl(config)).toBe('https://rpc.example');
    expect(configProblems({ ...base, feeConfigRpcUrl: 'ftp://rpc.example' })).toEqual([
      'feeConfigRpcUrl: must be a https:// URL',
    ]);
  });

  it('defaults to the Solana rpcUrl, else the public endpoint of the network', () => {
    expect(feeConfigRpcUrl({ network: 'devnet', rpcUrl: 'https://mine.example' })).toBe(
      'https://mine.example',
    );
    expect(feeConfigRpcUrl({ network: 'devnet' })).toBe('https://api.devnet.solana.com');
    expect(feeConfigRpcUrl({ network: 'mainnet' })).toBe('https://api.mainnet-beta.solana.com');
  });
});

describe('the records of a split payment', () => {
  const SIG = signatureOf(3);
  const paid = {
    signature: SIG,
    blockTime: T0,
    caip19: USDC_DEVNET_CAIP19,
    medium: 'solana-devnet',
  };

  it('the completed status carries the total and the recorded fee', () => {
    const store = key();
    const buyer = key();
    const split = order('k', {
      buyerPubkey: buyer.pubkey,
      paid: { ...paid, amount: '1000000', fee: '30000' },
    });
    const wrap = buildDeliveryReply(split, store.secretKey, T0 + 5);
    const unwrapped = unwrapOrderMessage(wrap.recipientWrap, buyer.secretKey);
    const message = unwrapped?.message;
    expect(message?.type === 'status' ? message.receipt : undefined).toMatchObject({
      amount: '1000000',
      fee: '30000',
    });
    // A payment recorded before fee support says fee 0.
    const old = order('k', { buyerPubkey: buyer.pubkey, paid: { ...paid, amount: '1000000' } });
    const oldMessage = unwrapOrderMessage(
      buildDeliveryReply(old, store.secretKey, T0 + 5).recipientWrap,
      buyer.secretKey,
    )?.message;
    expect(oldMessage?.type === 'status' ? oldMessage.receipt?.fee : undefined).toBe('0');
  });

  it('orders prints the net, the fee and an unresolved mark', () => {
    const state = emptyLedger();
    state.orders.a = order('a', { paid: { ...paid, amount: '1000000', fee: '30000' } });
    state.orders.b = order('b', { createdAt: T0 + 1, feeUnresolved: { [SIG]: T0 + 5 } });
    const lines = orderLines(state, 'c'.repeat(64));
    expect(lines[0]).toContain(' 1000000 net=970000 fee=30000 ');
    expect(lines[1]).toContain(` feeUnresolved=${SIG}`);
    expect(lines[0]).not.toContain('feeUnresolved');
  });

  it('a paid order loses its unresolved mark', () => {
    const open = order('a');
    expect(markFeeUnresolved(open, SIG, NOW)).toBe(true);
    expect(markFeeUnresolved(open, SIG, NOW + 1)).toBe(false);
    expect(open.feeUnresolved).toEqual({ [SIG]: NOW });
    recordPayment(open, { ...paid, amount: '1', fee: '0' }, undefined);
    expect(open.feeUnresolved).toBeUndefined();
  });

  it('an unresolved order closed by the window is kept for a hand answer, which removes it', () => {
    const state: LedgerState = emptyLedger();
    state.orders.a = order('a', { feeUnresolved: { [SIG]: T0 + 5 } });
    state.orders.b = order('b');
    const closed = pruneExpiredOrders(state, T0 + 10 * 86_400);
    expect(closed).toEqual([{ key: 'a', tx: SIG, at: T0 + 5 }]);
    expect(state.unresolvedPayments).toEqual([{ key: 'a', tx: SIG, at: T0 + 5 }]);
    expect(state.closedOrders).toEqual({ a: true, b: true });
    expect(orderLines(state, 'c'.repeat(64)).join('\n')).toContain(`closed unresolved: a ${SIG}`);
    applyHandAnswer(state, 'a', {
      kind: 'delivered',
      reportedTxs: [],
      refusedTxs: [],
      noLegTxs: [],
    });
    expect(state.unresolvedPayments).toEqual([]);
  });

  it('the admin totals count what reached the merchant, net of the fee', () => {
    const credit = (tx: string, amount: string, fee: string): Credit => ({
      tx,
      amount,
      fee,
      medium: 'solana-devnet',
    });
    const row = (credits: Credit[]): OrderRow => ({ credits }) as unknown as OrderRow;
    const totals = totalsOf([row([credit('a', '1000000', '30000'), credit('b', '500000', '0')])]);
    expect(totals.unknownAsset).toEqual([{ medium: 'solana-devnet', subunits: '1470000' }]);
  });

  it('never counts a receipt whose fee is above its amount below zero', () => {
    const credit: Credit = { tx: 'x', amount: '100', fee: '200', medium: 'solana-devnet' };
    const totals = totalsOf([{ credits: [credit] } as unknown as OrderRow]);
    expect(totals.unknownAsset).toEqual([{ medium: 'solana-devnet', subunits: '100' }]);
  });
});
