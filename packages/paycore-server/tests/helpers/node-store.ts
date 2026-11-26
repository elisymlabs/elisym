import { buildOrderMessage, deriveOrderPaymentReference, wrapOrderMessage } from '@elisym/commerce';
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import type { Product } from '@merchant-node/products';
import { runSetupPass } from '@merchant-node/setup-ledger';
import { buildStoreSignedEvents, ownerEventTemplates } from '@merchant-node/store-events';
import { publishTerms } from '@merchant-node/terms';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  D,
  type Key,
  PAYOUT,
  PRICE,
  USDC_DEVNET_CAIP19,
  key,
} from '../../../merchant-node/tests/fixtures';
import type { Db } from '../../src/db/db';
import { KeyVault } from '../../src/db/keys';
import { healPass } from '../../src/node/holder-requests';
import type { OperatorRpcs } from '../../src/node/load';
import type { SetupPassDeps } from '../../src/node/setup-pass';
import { type SupervisorDeps, StoreSupervisor } from '../../src/node/supervisor';
import { StorePools } from '../../src/relay/pools';
import { type LeasedStore, type StoreStatus, acquireLeases } from '../../src/state/leases';
import { type LedgerHandle, insertLedger } from '../../src/state/ledger-store';
import type { RelayWorld } from './node-world';

/** The tests' clock: near the real one, so gift wraps (dated from the real clock) are recent. */
export const NOW = Math.floor(Date.now() / 1000);
export const RELAY = 'wss://inbox.example.com';
export const MASTER_KEY = '11'.repeat(32);
export const SOLANA_RPC = 'https://solana.operator.example';
export const TEMPO_RPC = 'https://tempo.operator.example';
export const BASE_RPC = 'https://base.operator.example';
export const RPCS: OperatorRpcs = {
  devnet: { solana: SOLANA_RPC, tempo: TEMPO_RPC, evm: { base: BASE_RPC } },
};
export const TEMPO_DEVNET_CAIP19 = 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000';
export const TEMPO_PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
export const BASE_DEVNET_CAIP19 = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';
export const WEBHOOK_SECRET = 'w'.repeat(64);
export const SOLANA_PAYOUTS = [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }];

export { D, PAYOUT, PRICE, USDC_DEVNET_CAIP19, key, type Key };

export const PRODUCT: Product = {
  d: D,
  title: 'Course',
  description: 'A course.',
  priceUsd: '1',
  onSale: true,
  file: `products/${D}`,
};

export function vault(): KeyVault {
  return new KeyVault(MASTER_KEY);
}

/** A ledger selling `D` at `PRICE` in devnet USDC to `PAYOUT` since an hour ago, that list recorded. */
export function sellingLedger(): LedgerState {
  const state = emptyLedger();
  state.terms = publishTerms(
    [],
    { d: D, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
    NOW - 3600,
    NOW - 3600,
  );
  state.payto = { createdAt: NOW - 3600, payouts: JSON.stringify(SOLANA_PAYOUTS) };
  return state;
}

export interface SeedOptions {
  owner?: Key;
  store?: Key;
  status?: StoreStatus;
  inboxRelays?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  products?: Product[];
  state?: LedgerState;
  draftPayouts?: unknown[];
  evmCredit?: 'fast' | 'safe';
  ownerEvents?: { event: NostrEvent; payoutsString?: string; recorded: boolean }[];
}

/** One store's rows, as the admin API and import would write them. */
export async function seedStore(
  db: Db,
  keys: KeyVault,
  options: SeedOptions = {},
): Promise<{ owner: Key; store: Key }> {
  const owner = options.owner ?? key();
  const store = options.store ?? key();
  await db.query(
    "insert into tiers (name, max_products) values ('basic', 10) on conflict (name) do nothing",
  );
  await db.query(
    `insert into stores (owner, store_pubkey, status, tier, plan_source, created_at)
     values ($1, $2, $3, 'basic', 'operator', $4)`,
    [owner.pubkey, store.pubkey, options.status ?? 'active', NOW - 7200],
  );
  const webhookSecret =
    options.webhookSecret === undefined
      ? null
      : keys.seal(Buffer.from(options.webhookSecret, 'utf8'), owner.pubkey, 'webhook');
  await db.query('insert into store_keys (owner, store_key, webhook_secret) values ($1, $2, $3)', [
    owner.pubkey,
    keys.seal(store.secretKey, owner.pubkey, 'store'),
    webhookSecret,
  ]);
  await db.query(
    `insert into store_config (owner, name, network, draft_payouts, evm_credit, webhook_url,
       inbox_relays, updated_at)
     values ($1, 'Shop', 'devnet', $2, $3, $4, $5, $6)`,
    [
      owner.pubkey,
      JSON.stringify(options.draftPayouts ?? SOLANA_PAYOUTS),
      options.evmCredit ?? 'fast',
      options.webhookUrl ?? null,
      options.inboxRelays ?? [RELAY],
      NOW - 7200,
    ],
  );
  for (const product of options.products ?? [PRODUCT]) {
    await db.query(
      `insert into products (owner, d, title, description, summary, url, price_usd, on_sale, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        owner.pubkey,
        product.d,
        product.title,
        product.description,
        product.summary ?? null,
        product.url ?? null,
        product.priceUsd,
        product.onSale,
        NOW - 7200,
      ],
    );
  }
  for (const entry of options.ownerEvents ?? []) {
    await insertOwnerEvent(db, owner.pubkey, entry.event, entry.payoutsString, entry.recorded);
  }
  await db.transaction((tx) =>
    insertLedger(tx, owner.pubkey, options.state ?? sellingLedger(), NOW - 7200),
  );
  return { owner, store };
}

export async function insertOwnerEvent(
  db: Db,
  owner: string,
  event: NostrEvent,
  payoutsString: string | undefined,
  recorded: boolean,
): Promise<void> {
  await db.query(
    `insert into owner_events (id, owner, kind, event, payouts_string, committed_at, recorded)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [event.id, owner, event.kind, JSON.stringify(event), payoutsString ?? null, NOW, recorded],
  );
}

/** The owner's signed payout list (10133) and hosted authorization (30490). */
export function ownerEvents(
  owner: Key,
  store: Key,
  payouts: { caip19: string; address: string }[],
  paytoCreatedAt: number,
): { payoutList: NostrEvent; authorization: NostrEvent } {
  const templates = ownerEventTemplates(
    { payouts },
    owner.pubkey,
    store.pubkey,
    paytoCreatedAt,
    paytoCreatedAt,
    { mode: 'hosted', operator: 'paycore.test' },
  );
  return {
    payoutList: finalizeEvent(templates.payoutList, owner.secretKey),
    authorization: finalizeEvent(templates.authorization, owner.secretKey),
  };
}

/**
 * A store published on `world` the way the server's setup pass would: the
 * owner events committed and recorded, the listings out, the ledger recording
 * all of it as of an hour ago. Returns the seeding options.
 */
export async function publishedStore(
  world: RelayWorld,
  payouts: { caip19: string; address: string }[] = SOLANA_PAYOUTS,
  products: Product[] = [PRODUCT],
): Promise<SeedOptions & { owner: Key; store: Key }> {
  const owner = key();
  const store = key();
  const at = NOW - 3600;
  const signed = ownerEvents(owner, store, payouts, at);
  const state = emptyLedger();
  const payoutsString = JSON.stringify(payouts);
  await runSetupPass(state, {
    pool: world.pool(),
    relays: [...new Set([...OFFER_RELAYS, RELAY])],
    defaultRelays: OFFER_RELAYS,
    pubkeys: { storePubkey: store.pubkey, ownerPubkey: owner.pubkey },
    products: new Map(products.map((product) => [product.d, product])),
    payouts,
    payoutsString,
    storeSecretKey: store.secretKey,
    sign: ({ startedAt }) => ({
      payoutList: signed.payoutList,
      others: [
        ...buildStoreSignedEvents(
          { name: 'Shop', inboxRelays: [RELAY] },
          store.secretKey,
          owner.pubkey,
          startedAt,
          true,
        ),
        signed.authorization,
      ],
    }),
    publish: async (event) => {
      world.add(event);
      return true;
    },
    now: () => at,
  });
  return {
    owner,
    store,
    state,
    products,
    draftPayouts: payouts,
    ownerEvents: [
      { event: signed.payoutList, payoutsString, recorded: true },
      { event: signed.authorization, recorded: true },
    ],
  };
}

/** The setup pass's deps over `world` (its own pools: the store's node is stopped while it runs). */
export function testSetupDeps(
  db: Db,
  keys: KeyVault,
  world: RelayWorld,
  overrides: Partial<SetupPassDeps> = {},
): SetupPassDeps {
  return {
    db,
    vault: keys,
    pools: new StorePools(world.factory()),
    treasuries: { refreshFor: async () => ({ kind: 'unreachable', problem: 'offline' }) },
    inboxRelayAllowlist: [RELAY],
    log: () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

/** The supervisor's heal hook as the server wires it (`healPass`), counting the heals. */
export function testHeal(
  db: Db,
  keys: KeyVault,
  world: RelayWorld,
): { heal: (owner: string, handle: LedgerHandle) => Promise<void>; heals: string[] } {
  const heals: string[] = [];
  const pass = healPass(testSetupDeps(db, keys, world));
  const heal = async (owner: string, handle: LedgerHandle) => {
    heals.push(owner);
    await pass(owner, handle);
  };
  return { heal, heals };
}

/** An EVM client that answers nothing (no rail under test reaches it). */
export const SILENT_EVM: Eip1193Client = {
  request: () => Promise.reject(new Error('no EVM chain in this test')),
};

export interface TestSupervisor {
  supervisor: StoreSupervisor;
  pools: StorePools;
  logs: string[];
}

/** A supervisor over `world`, the Solana `rpc`, an unreachable fee config and no EVM gates. */
export function testSupervisor(
  db: Db,
  keys: KeyVault,
  holder: string,
  world: RelayWorld,
  rpc: Rpc<SolanaRpcApi>,
  overrides: Partial<SupervisorDeps> = {},
): TestSupervisor {
  const logs: string[] = [];
  const pools = new StorePools(world.factory());
  const supervisor = new StoreSupervisor({
    db,
    vault: keys,
    holder,
    pools,
    chains: { solana: () => rpc, tempo: () => SILENT_EVM, evm: () => SILENT_EVM },
    treasuries: { refreshFor: async () => ({ kind: 'unreachable', problem: 'offline' }) },
    boot: { register: () => () => undefined },
    webhookSlots: {
      forStore: () => async () => new Response(null, { status: 200 }),
    },
    rpcs: RPCS,
    inboxRelayAllowlist: [RELAY],
    publicReads: () => world.pool(),
    userAgent: 'paycore-server/test',
    // Sweep at once: the tests wait on a node's first sweep.
    firstSweepDelayMs: () => 0,
    log: (message) => logs.push(message),
    now: () => NOW,
    ...overrides,
  });
  return { supervisor, pools, logs };
}

export async function lease(db: Db, holder: string, now = NOW): Promise<LeasedStore[]> {
  return acquireLeases(db, holder, now);
}

/** A buyer's order for `d` at `store` and its paid receipt naming `tx`, dated `createdAt` (a minute ago). */
export function orderWraps(
  store: Key,
  buyer: Key,
  orderId: string,
  tx: string,
  createdAt = NOW - 60,
): { order: NostrEvent; receipt: NostrEvent; reference: string; key: string } {
  const reference = deriveOrderPaymentReference({
    storePubkey: store.pubkey,
    buyerPubkey: buyer.pubkey,
    orderId,
  }).solana;
  const wrap = (message: Parameters<typeof buildOrderMessage>[0]) =>
    wrapOrderMessage(buildOrderMessage(message, createdAt), buyer.secretKey, store.pubkey)
      .recipientWrap;
  return {
    reference,
    key: `${buyer.pubkey}:${orderId}`,
    order: wrap({
      type: 'order',
      storePubkey: store.pubkey,
      orderId,
      items: [{ product: `30402:${store.pubkey}:${D}`, quantity: 1 }],
      total: { amount: '1', currency: 'USD' },
    }),
    receipt: wrap({
      type: 'receipt',
      storePubkey: store.pubkey,
      orderId,
      payment: { medium: 'solana-devnet', reference, tx },
    }),
  };
}

/** The ledger as the database holds it now. */
export async function storedLedger(db: Db, owner: string): Promise<LedgerState> {
  const [row] = await db.query<{ state: string }>('select state from ledgers where owner = $1', [
    owner,
  ]);
  if (row === undefined) {
    throw new Error(`no ledger row for ${owner}`);
  }
  return JSON.parse(row.state) as LedgerState;
}

export async function storeStatus(db: Db, owner: string): Promise<string | undefined> {
  const [row] = await db.query<{ status: string }>('select status from stores where owner = $1', [
    owner,
  ]);
  return row?.status;
}

export async function openAlerts(
  db: Db,
  owner: string,
): Promise<{ kind: string; message: string; count: number }[]> {
  return db.query(
    `select kind, message, count from alerts where owner = $1 and cleared_at is null order by kind`,
    [owner],
  );
}

/** Let pending promises and real I/O (pglite, signing) run; faked timers stay put. */
export async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Poll `check` until it holds (real time), or fail with `what`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
