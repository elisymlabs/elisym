/**
 * A leased store read from the database into what merchant-node runs with:
 * its `MerchantConfig` (the ACTIVE payouts, the rails they and the standing
 * terms need, the operator's RPCs, the allowlisted inbox relays), its
 * products, its secrets, and a fenced handle on its ledger.
 */
import { MAX_FUTURE_SKEW_SECS, parseCaip19 } from '@elisym/commerce';
import { WEBHOOK_MIN_SECRET_BYTES } from '@elisym/commerce/webhook';
import { type Network, settlementOf } from '@elisym/pay-core';
import {
  type Eip3009Slug,
  type MerchantConfig,
  type TempoNetwork,
  isEip3009Slug,
} from '@merchant-node/config';
import { UNPAID_ORDER_LIFETIME_SECS } from '@merchant-node/constants';
import type { LedgerState } from '@merchant-node/ledger';
import type { Product } from '@merchant-node/products';
import { checkoutRelaySpelling } from '@merchant-node/relays';
import type { StoreConfig } from '@merchant-node/store-events';
import type { TermsPeriod } from '@merchant-node/terms';
import type { WebhookTarget } from '@merchant-node/webhook';
import { getPublicKey } from 'nostr-tools/pure';
import type { Db, Queryable } from '../db/db';
import type { KeyVault } from '../db/keys';
import type { StoreStatus } from '../state/leases';
import { type LedgerHandle, PgLedgerStore } from '../state/ledger-store';

/** The operator's RPCs of one network: stores never name their own. */
export interface NetworkRpcs {
  solana?: string;
  tempo?: string;
  evm?: Partial<Record<Eip3009Slug, string>>;
}

export type OperatorRpcs = Partial<Record<Network, NetworkRpcs>>;

/** The chains a store must verify payments on (P10). */
export interface StoreRails {
  solana: boolean;
  tempo: boolean;
  evm: Eip3009Slug[];
}

/** An owner event the server committed for this store (the newest decide a heal). */
export interface CommittedOwnerEvent {
  id: string;
  kind: number;
  createdAt: number;
  recorded: boolean;
}

export interface StoreBundle {
  owner: string;
  status: StoreStatus;
  storePubkey: string;
  storeSecretKey: Uint8Array;
  config: MerchantConfig;
  /** The chains the store's payouts and standing terms need (P10). */
  rails: StoreRails;
  /** Rails the store needs and the operator has no RPC for: off in `config`, the store runs `degraded`. */
  unavailableRails: string[];
  products: Map<string, Product>;
  /**
   * The webhook sender's target: present when the store has a webhook URL and
   * its secret. A URL without a secret still queues entries (`config.webhook`),
   * sent once a secret exists.
   */
  webhook?: WebhookTarget;
  /** The store has a webhook URL and no secret yet: the store runs `degraded`. */
  webhookSecretMissing: boolean;
  committed: CommittedOwnerEvent[];
  /** The ledger as stored (not yet upgraded: the start checks do it). */
  handle: LedgerHandle;
}

export interface LoadDeps {
  holder: string;
  /** The lease epoch the run holds. */
  epoch: number;
  rpcs: OperatorRpcs;
  /** `PAYCORE_INBOX_RELAYS` (P7). */
  inboxRelayAllowlist: readonly string[];
  /** Seconds. */
  now: () => number;
  ledgers?: PgLedgerStore;
}

/**
 * A start the store's own data refuses (not a passing outage): the store goes
 * `halted` with an alert at once instead of counting failed starts.
 */
export class StartRefused extends Error {
  constructor(
    readonly owner: string,
    problem: string,
  ) {
    super(problem);
    this.name = 'StartRefused';
  }
}

/** Statuses winding the store down (step 15): every product is sold out. */
export const WINDING_DOWN_STATUSES: readonly StoreStatus[] = ['suspending', 'suspended'];

/** Past the end of a terms period by this much, nothing can pay it any more (P10). */
export const TERMS_STAND_SECS = UNPAID_ORDER_LIFETIME_SECS + MAX_FUTURE_SKEW_SECS;

const TEMPO_NETWORK: Record<Network, TempoNetwork> = { mainnet: 'mainnet', devnet: 'moderato' };

interface StoreRow extends Record<string, unknown> {
  status: StoreStatus;
  store_pubkey: string;
  store_key: Uint8Array | null;
  webhook_secret: Uint8Array | null;
  name: string | null;
  nip05: string | null;
  network: Network | null;
  evm_credit: 'fast' | 'safe' | null;
  webhook_url: string | null;
  inbox_relays: string[] | null;
}

export interface ProductRow extends Record<string, unknown> {
  d: string;
  title: string;
  description: string;
  summary: string | null;
  url: string | null;
  price_usd: string;
  on_sale: boolean;
}

/**
 * The active payouts (P9): exactly the list the ledger recorded when its
 * payout list went out, parsed back from its canonical string. No list yet
 * (a store never set up): none.
 */
export function activePayouts(state: LedgerState, owner: string): StoreConfig['payouts'] {
  if (state.payto === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.payto.payouts);
  } catch {
    throw new StartRefused(owner, 'the recorded payout list is not JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new StartRefused(owner, 'the recorded payout list is not a list');
  }
  return parsed.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('caip19' in entry) ||
      !('address' in entry) ||
      typeof entry.caip19 !== 'string' ||
      typeof entry.address !== 'string'
    ) {
      throw new StartRefused(
        owner,
        'the recorded payout list holds an entry without coin or address',
      );
    }
    const signature =
      'signature' in entry && typeof entry.signature === 'string' ? entry.signature : undefined;
    return {
      caip19: entry.caip19,
      address: entry.address,
      ...(signature === undefined ? {} : { signature }),
    };
  });
}

/** Whether terms ended (or still standing) can still be paid at `now`. */
function stillStands(period: TermsPeriod, now: number): boolean {
  return period.until === undefined || now - period.until < TERMS_STAND_SECS;
}

/**
 * The rails of a store (P10): the chains of its active payouts, and of every
 * ledger terms still standing (not ended, or ended less than
 * `TERMS_STAND_SECS` ago). A chain dropped from the payouts keeps its sweep
 * until its last terms can no longer be paid. Chains of another network are
 * ignored.
 */
export function storeRails(
  payouts: readonly { caip19: string }[],
  terms: readonly TermsPeriod[],
  network: Network,
  now: number,
): StoreRails {
  const ids = [
    ...payouts.map((payout) => payout.caip19),
    ...terms.filter((period) => stillStands(period, now)).map((period) => period.terms.caip19),
  ];
  const rails: StoreRails = { solana: false, tempo: false, evm: [] };
  for (const id of ids) {
    const chain = parseCaip19(id)?.chain;
    if (chain === undefined || chain.network !== network) {
      continue;
    }
    const rail = settlementOf(chain);
    if (rail === 'solana') {
      rails.solana = true;
    } else if (rail === 'tempo') {
      rails.tempo = true;
    } else if (rail === 'eip3009' && isEip3009Slug(chain.slug) && !rails.evm.includes(chain.slug)) {
      rails.evm.push(chain.slug);
    }
  }
  return rails;
}

/** The inbox relays in the allowlist's spelling; any relay outside it refuses the start (P7). */
export function allowedInboxRelays(
  owner: string,
  relays: readonly string[],
  allowlist: readonly string[],
): string[] {
  const spelled = (relay: string) => checkoutRelaySpelling(relay) ?? relay;
  const allowed = new Set(allowlist.map(spelled));
  const outside = relays.filter((relay) => !allowed.has(spelled(relay)));
  if (outside.length > 0) {
    throw new StartRefused(owner, `inbox relays outside the allowlist: ${outside.join(', ')}`);
  }
  if (relays.length === 0) {
    throw new StartRefused(owner, 'no inbox relay');
  }
  return [...new Set(relays.map(spelled))];
}

/**
 * The parts of `MerchantConfig` that switch rails on, from the operator's RPCs
 * only: `rpcUrl` (Solana), `tempo`, `evm`. A rail with no operator RPC stays
 * off and is named in `unavailable` (the store runs without it, `degraded`,
 * instead of every rail stopping for one).
 */
export function railConfig(
  network: Network,
  rails: StoreRails,
  rpcs: OperatorRpcs,
  credit: 'fast' | 'safe',
): { config: Pick<MerchantConfig, 'rpcUrl' | 'tempo' | 'evm'>; unavailable: string[] } {
  const operator = rpcs[network] ?? {};
  const config: Pick<MerchantConfig, 'rpcUrl' | 'tempo' | 'evm'> = {};
  const unavailable: string[] = [];
  if (rails.solana) {
    if (operator.solana === undefined) {
      unavailable.push(`solana-${network}`);
    } else {
      config.rpcUrl = operator.solana;
    }
  }
  if (rails.tempo) {
    if (operator.tempo === undefined) {
      unavailable.push(`tempo-${network}`);
    } else {
      config.tempo = { network: TEMPO_NETWORK[network], rpcUrl: operator.tempo };
    }
  }
  for (const slug of rails.evm) {
    const rpcUrl = operator.evm?.[slug];
    if (rpcUrl === undefined) {
      unavailable.push(`${slug}-${network}`);
    } else {
      config.evm = { ...config.evm, [slug]: { rpcUrl, credit } };
    }
  }
  return { config, unavailable };
}

/** A product row as merchant-node reads a product; `soldOut` stops it whatever the row says. */
export function productOf(row: ProductRow, soldOut = false): Product {
  return {
    d: row.d,
    title: row.title,
    description: row.description,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.url === null ? {} : { url: row.url }),
    priceUsd: row.price_usd,
    onSale: soldOut ? false : row.on_sale,
    file: `products/${row.d}`,
  };
}

function webhookOf(
  owner: string,
  vault: KeyVault,
  url: string,
  sealed: Uint8Array | null,
): WebhookTarget | undefined {
  if (sealed === null) {
    return undefined;
  }
  const secret = Buffer.from(vault.open(sealed, owner, 'webhook')).toString('utf8');
  if (Buffer.byteLength(secret, 'utf8') < WEBHOOK_MIN_SECRET_BYTES) {
    throw new StartRefused(owner, 'the webhook secret is too short');
  }
  return { url, secret };
}

/** The owner events the server committed for `owner`, in commit order. */
export async function readCommitted(db: Queryable, owner: string): Promise<CommittedOwnerEvent[]> {
  const rows = await db.query<{
    id: string;
    kind: number;
    created_at: number;
    recorded: boolean;
  }>(
    `select id, kind, (event->>'created_at')::bigint as created_at, recorded
     from owner_events where owner = $1 order by committed_at`,
    [owner],
  );
  return rows.map((event) => ({
    id: event.id,
    kind: event.kind,
    createdAt: event.created_at,
    recorded: event.recorded,
  }));
}

/** The store's products, oldest `d` first; all sold out while the store winds down. */
export async function readProducts(
  db: Queryable,
  owner: string,
  status: StoreStatus,
): Promise<Map<string, Product>> {
  const rows = await db.query<ProductRow>(
    `select d, title, description, summary, url, price_usd, on_sale
     from products where owner = $1 order by d`,
    [owner],
  );
  const soldOut = WINDING_DOWN_STATUSES.includes(status);
  return new Map(rows.map((product) => [product.d, productOf(product, soldOut)]));
}

/**
 * Read a leased store: its rows, its secrets opened with the vault, and a
 * handle on its ledger for this run. Throws `StartRefused` when the store's
 * own data cannot run (relays outside the allowlist, a sealed key that does
 * not open), any other error for a read that may pass on a retry. A rail with
 * no operator RPC and a webhook URL with no secret do not refuse the start:
 * `unavailableRails` / `webhookSecretMissing` say so (the store runs `degraded`).
 */
export async function loadStoreBundle(
  db: Db,
  vault: KeyVault,
  owner: string,
  deps: LoadDeps,
): Promise<StoreBundle> {
  const [row] = await db.query<StoreRow>(
    `select s.status, s.store_pubkey, k.store_key, k.webhook_secret, c.name, c.nip05, c.network,
            c.evm_credit, c.webhook_url, c.inbox_relays
     from stores s
     left join store_keys k on k.owner = s.owner
     left join store_config c on c.owner = s.owner
     where s.owner = $1`,
    [owner],
  );
  if (row === undefined) {
    throw new Error(`no store ${owner}`);
  }
  if (row.store_key === null) {
    throw new StartRefused(owner, 'the store has no store key');
  }
  if (
    row.name === null ||
    row.network === null ||
    row.inbox_relays === null ||
    row.evm_credit === null
  ) {
    throw new StartRefused(owner, 'the store has no config');
  }
  const storeSecretKey = vault.open(row.store_key, owner, 'store');
  if (getPublicKey(storeSecretKey) !== row.store_pubkey) {
    throw new StartRefused(owner, 'the sealed store key is not the store pubkey');
  }
  const inboxRelays = allowedInboxRelays(owner, row.inbox_relays, deps.inboxRelayAllowlist);
  const webhook =
    row.webhook_url === null
      ? undefined
      : webhookOf(owner, vault, row.webhook_url, row.webhook_secret);
  const products = await readProducts(db, owner, row.status);
  const committed = await readCommitted(db, owner);
  const ledgers = deps.ledgers ?? new PgLedgerStore(db, deps.now);
  const handle = await ledgers.open(owner, deps.epoch, deps.holder);
  const payouts = activePayouts(handle.state, owner);
  const rails = storeRails(payouts, handle.state.terms ?? [], row.network, deps.now());
  const operatorRails = railConfig(row.network, rails, deps.rpcs, row.evm_credit);
  const config: MerchantConfig = {
    name: row.name,
    ...(row.nip05 === null ? {} : { nip05: row.nip05 }),
    network: row.network,
    payouts,
    inboxRelays,
    ...operatorRails.config,
    ...(row.webhook_url === null ? {} : { webhook: { url: row.webhook_url } }),
  };
  return {
    owner,
    status: row.status,
    storePubkey: row.store_pubkey,
    storeSecretKey,
    config,
    rails,
    unavailableRails: operatorRails.unavailable,
    products,
    ...(webhook === undefined ? {} : { webhook }),
    webhookSecretMissing: row.webhook_url !== null && webhook === undefined,
    committed,
    handle,
  };
}
