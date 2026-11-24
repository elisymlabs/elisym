import { randomBytes } from 'node:crypto';
import { parseCaip19, splitNip05, verifyPaytoProof } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import {
  type EvmCredit,
  type MerchantConfig,
  configProblems,
  isEip3009Slug,
  payoutsSchema,
  priceProblems,
  webhookUrlProblem,
} from '@merchant-node/config';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import {
  PRODUCT_D_RE,
  ProductInputSchema,
  storableString as storable,
} from '@merchant-node/product-rules';
import { orderProductD } from '@merchant-node/products';
import { checkoutRelaySpelling } from '@merchant-node/relays';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as z from 'zod';
import { recordAuthId } from '../admin/auth-ids';
import { type RequestKind, insertRequest } from '../admin/requests';
import { type NetworkRpcs, hasOperatorRpc } from '../config';
import { FetchGuardError, checkUrl } from '../connectors/fetch-guard';
import type { Db, Queryable } from '../db/db';
import type { KeyVault } from '../db/keys';
import { WINDING_DOWN_STATUSES, activePayouts } from '../node/load';
import type { StoreStatus } from './leases';
import { insertLedger, parseLedger } from './ledger-store';

/** A store not on a tier yet (`pending`) may hold this many products on sale. */
export const PENDING_MAX_PRODUCTS = 20;
/** The most inbox relays a store names (merchant-node's own bound). */
const MAX_INBOX_RELAYS = 5;
/** A webhook secret: 32 random bytes as 64 hex characters (`openssl rand -hex 32`). */
const WEBHOOK_SECRET_BYTES = 32;
const MAX_TAG_VALUE = 1024;
const MAX_NAME = 100;
const REFUND_AMOUNT_RE = /^[1-9]\d{0,38}$/;

export interface Payout {
  caip19: string;
  address: string;
  signature?: string;
}

export interface StoreRecord {
  owner: string;
  storePubkey: string;
  status: StoreStatus;
  statusReason: string | undefined;
  tier: { name: string; maxProducts: number } | undefined;
  suspendingSince: number | undefined;
  createdAt: number;
}

export interface StoreSettings {
  name: string;
  nip05: string | undefined;
  network: Network;
  /** The draft (P9): active payouts are the ledger's `state.payto`. */
  draftPayouts: Payout[];
  evmCredit: EvmCredit;
  webhookUrl: string | undefined;
  /** The merchant's inbox relays (the draft): active once a setup pass got their 10050 out. */
  inboxRelays: string[];
  /** The inbox relays the node listens on and replies to now. */
  activeInboxRelays: string[];
  revision: number;
  updatedAt: number;
}

export interface ProductRecord {
  d: string;
  title: string;
  description: string;
  summary: string | undefined;
  url: string | undefined;
  priceUsd: string;
  onSale: boolean;
  updatedAt: number;
}

export interface CreateStoreInput {
  name: string;
  network: Network;
  nip05?: string;
}

export interface ConfigInput {
  name: string;
  nip05?: string;
  payouts: unknown;
  evmCredit?: EvmCredit;
  webhookUrl?: string | null;
  inboxRelays: string[];
}

export interface ProductInput {
  title: string;
  description: string;
  summary?: string;
  url?: string;
  priceUsd: string;
  onSale?: boolean;
}

/** A hand answer as the admin asks it (step 14 applies it). */
export type HandInput =
  | { kind: 'complete' }
  | { kind: 'refunded'; tx: string; amount: string; asset?: string };

export interface Refusal {
  ok: false;
  error: string;
  problems?: string[];
}

/** One order of the ledger as the admin shows it, buyer email included (server-mode orders, phase 2). */
export interface OrderView {
  key: string;
  buyerPubkey: string;
  orderId: string;
  product: string;
  /** The product's current title by its `d` (it may have changed since the order); null once removed. */
  productTitle: string | null;
  createdAt: number;
  email: string | undefined;
  customerRef: string | undefined;
  reportedTxs: string[];
  paid:
    | {
        signature: string;
        amount: string;
        fee: string;
        caip19: string;
        medium: string;
        blockTime: number;
      }
    | undefined;
  webhook: { state: string; attempts: number; lastStatus: number | undefined } | undefined;
  deliveredAt: number | undefined;
}

export interface OrdersView {
  orders: OrderView[];
  answeredByHand: Record<string, { kind: string; tx?: string; amount?: string; caip19?: string }>;
  unresolvedPayments: { key: string; tx: string; at: number }[];
}

export interface StoreDirectoryOptions {
  db: Db;
  vault: KeyVault;
  /** PAYCORE_INBOX_RELAYS, in the checkout's spelling (P7). */
  inboxRelays: readonly string[];
  /** The operator's RPCs: a payout on a chain with none cannot be verified, so it is refused. */
  rpcs: Record<Network, NetworkRpcs>;
  now?: () => number;
  pendingMaxProducts?: number;
}

export { ProductInputSchema };

export const ConfigInputSchema = z
  .object({
    name: storable(MAX_NAME),
    nip05: z.string().max(MAX_TAG_VALUE).optional(),
    payouts: z.unknown(),
    evmCredit: z.enum(['fast', 'safe']).optional(),
    webhookUrl: z.string().max(2048).nullable().optional(),
    inboxRelays: z.array(z.string().max(MAX_TAG_VALUE)).min(1).max(MAX_INBOX_RELAYS),
  })
  .strict();

export const CreateStoreInputSchema = z
  .object({
    name: storable(MAX_NAME)
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, { message: 'is empty' }),
    network: z.enum(['mainnet', 'devnet']),
    nip05: z
      .string()
      .max(MAX_TAG_VALUE)
      .refine((value) => splitNip05(value) !== undefined, { message: 'is not a nip05 address' })
      .refine((value) => splitNip05(value)?.local !== 'owner', {
        message: 'cannot use the name "owner"',
      })
      .optional(),
  })
  .strict();

export const HandInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete') }).strict(),
  z
    .object({
      kind: z.literal('refunded'),
      tx: z.string().min(1).max(200),
      amount: z.string().regex(REFUND_AMOUNT_RE),
      asset: z
        .string()
        .max(MAX_TAG_VALUE)
        .refine((value) => parseCaip19(value) !== undefined, { message: 'is not a coin' })
        .optional(),
    })
    .strict(),
]);

/**
 * The canonical payouts string (P9): the list parsed through merchant-node's
 * config payouts schema, then `JSON.stringify` (keys `caip19`, `address`,
 * `signature?`, in list order) - what `state.payto.payouts` holds.
 */
export function canonicalPayouts(payouts: unknown): { list: Payout[]; text: string } | undefined {
  const parsed = payoutsSchema.safeParse(payouts);
  if (!parsed.success) {
    return undefined;
  }
  return { list: parsed.data, text: JSON.stringify(parsed.data) };
}

/**
 * Why a webhook URL is refused for a hosted store, or undefined: https, port
 * 443, a public DNS name (`webhookUrlProblem` refuses every IP literal, so a
 * private address can only come from DNS, which the send-time guard checks).
 */
export function hostedWebhookProblem(value: string): string | undefined {
  const problem = webhookUrlProblem(value, false);
  if (problem !== undefined) {
    return problem;
  }
  try {
    checkUrl(value);
  } catch (error) {
    return error instanceof FetchGuardError ? error.message : 'is not usable';
  }
  return undefined;
}

interface StoreRow extends Record<string, unknown> {
  owner: string;
  store_pubkey: string;
  status: StoreStatus;
  status_reason: string | null;
  tier: string | null;
  max_products: number | null;
  suspending_since: number | null;
  created_at: number;
}

interface ConfigRow extends Record<string, unknown> {
  name: string;
  nip05: string | null;
  network: Network;
  draft_payouts: unknown;
  evm_credit: EvmCredit;
  webhook_url: string | null;
  inbox_relays: string[];
  draft_inbox_relays: string[] | null;
  revision: number;
  updated_at: number;
}

interface ProductRow extends Record<string, unknown> {
  d: string;
  title: string;
  description: string;
  summary: string | null;
  url: string | null;
  price_usd: string;
  on_sale: boolean;
  updated_at: number;
}

function toStore(row: StoreRow): StoreRecord {
  return {
    owner: row.owner,
    storePubkey: row.store_pubkey,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    tier:
      row.tier === null || row.max_products === null
        ? undefined
        : { name: row.tier, maxProducts: row.max_products },
    suspendingSince: row.suspending_since ?? undefined,
    createdAt: row.created_at,
  };
}

function toSettings(row: ConfigRow): StoreSettings {
  const draft =
    typeof row.draft_payouts === 'string' ? JSON.parse(row.draft_payouts) : row.draft_payouts;
  return {
    name: row.name,
    nip05: row.nip05 ?? undefined,
    network: row.network,
    draftPayouts: Array.isArray(draft) ? (canonicalPayouts(draft)?.list ?? []) : [],
    evmCredit: row.evm_credit,
    webhookUrl: row.webhook_url ?? undefined,
    inboxRelays: row.draft_inbox_relays ?? row.inbox_relays,
    activeInboxRelays: row.inbox_relays,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function toProduct(row: ProductRow): ProductRecord {
  return {
    d: row.d,
    title: row.title,
    description: row.description,
    summary: row.summary ?? undefined,
    url: row.url ?? undefined,
    priceUsd: row.price_usd,
    onSale: row.on_sale,
    updatedAt: row.updated_at,
  };
}

const STORE_SELECT = `select s.owner, s.store_pubkey, s.status, s.status_reason, s.tier, t.max_products,
  s.suspending_since, s.created_at from stores s left join tiers t on t.name = s.tier`;

/** An edit of a store winding down: its listings are sold out for good. */
export const WINDING_DOWN_REFUSAL: Refusal = {
  ok: false,
  error: 'suspended',
  problems: ['the store is suspended or being suspended: it takes no more changes'],
};

/**
 * A request for a `suspended` store: no holder serves it any more, so it
 * would wait forever. A `suspending` store is still served (open orders).
 */
export const SUSPENDED_REFUSAL: Refusal = {
  ok: false,
  error: 'suspended',
  problems: ['the store is suspended: nothing serves it any more'],
};

/**
 * The stores as the admin API and the loader see them: rows, sealed keys,
 * the draft config, products, orders from the ledger row, and the requests a
 * change queues for the store's holder. Every merchant input is validated
 * here before anything is written.
 */
export class StoreDirectory {
  private readonly db: Db;
  private readonly vault: KeyVault;
  private readonly allowedRelays: readonly string[];
  private readonly rpcs: Record<Network, NetworkRpcs>;
  private readonly now: () => number;
  /** The products on sale a store on no tier (`pending`) may hold. */
  readonly pendingMaxProducts: number;

  constructor(options: StoreDirectoryOptions) {
    this.db = options.db;
    this.vault = options.vault;
    this.allowedRelays = options.inboxRelays;
    this.rpcs = options.rpcs;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.pendingMaxProducts = options.pendingMaxProducts ?? PENDING_MAX_PRODUCTS;
  }

  recordAuthId(id: string, expiresAt: number): Promise<boolean> {
    return recordAuthId(this.db, id, expiresAt);
  }

  async store(owner: string, tx: Queryable = this.db): Promise<StoreRecord | undefined> {
    const [row] = await tx.query<StoreRow>(`${STORE_SELECT} where s.owner = $1`, [owner]);
    return row === undefined ? undefined : toStore(row);
  }

  async settings(owner: string, tx: Queryable = this.db): Promise<StoreSettings | undefined> {
    const [row] = await tx.query<ConfigRow>(
      `select name, nip05, network, draft_payouts, evm_credit, webhook_url, inbox_relays,
         draft_inbox_relays, revision, updated_at
       from store_config where owner = $1`,
      [owner],
    );
    return row === undefined ? undefined : toSettings(row);
  }

  /** The ledger as the row holds it now (not upgraded): orders, terms, the active payouts. */
  async ledgerState(owner: string, tx: Queryable = this.db): Promise<LedgerState | undefined> {
    const [row] = await tx.query<{ state: string }>('select state from ledgers where owner = $1', [
      owner,
    ]);
    return row === undefined ? undefined : parseLedger(row.state, owner);
  }

  /**
   * Create a `pending` store for `owner` (R1: one per owner key): a new store
   * key S sealed, an empty ledger, the config with the allowlisted inbox
   * relays. An existing store is returned as it is (`created: false`).
   */
  async createStore(
    owner: string,
    input: CreateStoreInput,
  ): Promise<{ created: boolean; store: StoreRecord }> {
    const now = this.now();
    const storeKey = generateSecretKey();
    const storePubkey = getPublicKey(storeKey);
    const sealed = this.vault.seal(storeKey, owner, 'store');
    storeKey.fill(0);
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `insert into stores (owner, store_pubkey, status, created_at) values ($1, $2, 'pending', $3)
         on conflict (owner) do nothing returning 1`,
        [owner, storePubkey, now],
      );
      if (inserted.length > 0) {
        await tx.query('insert into store_keys (owner, store_key) values ($1, $2)', [
          owner,
          sealed,
        ]);
        await tx.query(
          `insert into store_config (owner, name, nip05, network, inbox_relays, updated_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            owner,
            input.name,
            input.nip05 ?? null,
            input.network,
            this.allowedRelays.slice(0, MAX_INBOX_RELAYS),
            now,
          ],
        );
        await insertLedger(tx, owner, emptyLedger(), now);
      }
      const store = await this.store(owner, tx);
      if (store === undefined) {
        throw new Error(`store ${owner} vanished while it was created`);
      }
      return { created: inserted.length > 0, store };
    });
  }

  /** The kinds of the store's open alerts (A15: the merchant sees kinds, never the messages). */
  async openAlertKinds(owner: string): Promise<string[]> {
    const rows = await this.db.query<{ kind: string }>(
      'select kind from alerts where owner = $1 and cleared_at is null order by kind',
      [owner],
    );
    return rows.map((row) => row.kind);
  }

  async hasWebhookSecret(owner: string): Promise<boolean> {
    const [row] = await this.db.query<{ set: boolean }>(
      'select webhook_secret is not null as set from store_keys where owner = $1',
      [owner],
    );
    return row?.set === true;
  }

  /** Lock the store's row for this transaction: edits of one store run one at a time. */
  private async lockedStore(tx: Queryable, owner: string): Promise<StoreRecord | undefined> {
    const [row] = await tx.query<StoreRow>(`${STORE_SELECT} where s.owner = $1 for update of s`, [
      owner,
    ]);
    return row === undefined ? undefined : toStore(row);
  }

  /** Queue `kind` for a store its holder serves; a pending store's rows wait for its activation. */
  private async queueFor(
    tx: Queryable,
    store: StoreRecord,
    kind: RequestKind,
    now: number,
  ): Promise<string | undefined> {
    return store.status === 'pending' ? undefined : insertRequest(tx, store.owner, kind, {}, now);
  }

  /** Why the draft config is refused, every problem; empty when it may be written. */
  checkConfig(
    owner: string,
    network: Network,
    input: ConfigInput,
    products: readonly ProductRecord[],
  ): { problems: string[]; payouts?: Payout[]; inboxRelays?: string[] } {
    const problems: string[] = [];
    const canonical = canonicalPayouts(input.payouts);
    if (canonical === undefined) {
      return {
        problems: ['payouts: must be a list of { caip19, address, signature }, at least one'],
      };
    }
    const rpcs = this.rpcs[network];
    canonical.list.forEach((payout, index) => {
      const path = `payouts.${index}`;
      const caip19 = parseCaip19(payout.caip19);
      if (caip19 === undefined) {
        problems.push(`${path}.caip19: must be a coin this server can verify`);
        return;
      }
      if (payout.signature === undefined) {
        problems.push(`${path}.signature: a wallet signature of the payout address is required`);
      } else if (
        !verifyPaytoProof({
          chain: caip19.chain,
          address: payout.address,
          ownerPubkey: owner,
          caip19: caip19.id,
          signature: payout.signature,
        })
      ) {
        problems.push(
          `${path}.signature: does not prove ${payout.address} for this owner and coin`,
        );
      }
      const served = caip19.chain.network !== network || hasOperatorRpc(rpcs, caip19.chain);
      if (!served) {
        problems.push(
          `${path}.caip19: this server takes no payments on ${caip19.chain.chainName ?? caip19.chain.caip2}`,
        );
      }
    });
    const inboxRelays = input.inboxRelays.map((relay) => checkoutRelaySpelling(relay) ?? relay);
    inboxRelays.forEach((relay, index) => {
      if (!this.allowedRelays.includes(relay)) {
        problems.push(
          `inboxRelays.${index}: not a relay this server allows (${this.allowedRelays.join(', ')})`,
        );
      }
    });
    const webhookUrl = input.webhookUrl ?? undefined;
    if (webhookUrl !== undefined) {
      const problem = hostedWebhookProblem(webhookUrl);
      if (problem !== undefined) {
        problems.push(`webhookUrl: ${problem}`);
      }
    }
    if (problems.length > 0) {
      return { problems };
    }
    // The node's own rules, on the config the node would run with (operator RPCs).
    const evm: NonNullable<MerchantConfig['evm']> = {};
    for (const [slug, rpcUrl] of Object.entries(rpcs.evm)) {
      if (isEip3009Slug(slug) && rpcUrl !== undefined) {
        evm[slug] = { rpcUrl, credit: input.evmCredit ?? 'fast' };
      }
    }
    const merchant: MerchantConfig = {
      name: input.name,
      ...(input.nip05 === undefined ? {} : { nip05: input.nip05 }),
      network,
      ...(rpcs.solana === undefined ? {} : { rpcUrl: rpcs.solana }),
      ...(rpcs.tempo === undefined
        ? {}
        : {
            tempo: {
              network: network === 'mainnet' ? ('mainnet' as const) : ('moderato' as const),
              rpcUrl: rpcs.tempo,
            },
          }),
      evm,
      inboxRelays,
      payouts: canonical.list,
      ...(webhookUrl === undefined ? {} : { webhook: { url: webhookUrl } }),
    };
    // The RPCs are the operator's: a missing one is reported per payout above, not as the merchant's field.
    const nodeProblems = configProblems(merchant).filter(
      (problem) => !problem.startsWith('rpcUrl:'),
    );
    problems.push(...nodeProblems, ...priceProblems(merchant, products));
    return problems.length > 0 ? { problems } : { problems, payouts: canonical.list, inboxRelays };
  }

  /**
   * Replace the draft config (P9: the payouts stay a draft until prepare ->
   * sign -> commit -> record; the inbox relays stay a draft until a setup pass
   * got their 10050 out, `draft_inbox_relays`). Refused with every problem when a payout has no
   * valid wallet signature, a chain has no operator RPC, an inbox relay is
   * outside the allowlist, the webhook URL is not https on port 443 to a
   * public host, or a product's price cannot be paid in a coin. With
   * `expectedRevision` (the admin route; import passes none), refused as
   * `stale_config` when the config changed since that revision was read.
   */
  async putConfig(
    owner: string,
    input: ConfigInput,
    expectedRevision?: number,
  ): Promise<{ ok: true; settings: StoreSettings; requestId: string | undefined } | Refusal> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      const current = await this.settings(owner, tx);
      if (store === undefined || current === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (WINDING_DOWN_STATUSES.includes(store.status)) {
        return WINDING_DOWN_REFUSAL;
      }
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, error: 'stale_config' };
      }
      const checked = this.checkConfig(
        owner,
        current.network,
        input,
        await this.products(owner, tx),
      );
      if (checked.payouts === undefined || checked.inboxRelays === undefined) {
        return { ok: false, error: 'bad_config', problems: checked.problems };
      }
      await tx.query(
        `update store_config set name = $2, nip05 = $3, draft_payouts = $4::jsonb, evm_credit = $5,
           webhook_url = $6, draft_inbox_relays = $7, revision = revision + 1, updated_at = $8
         where owner = $1`,
        [
          owner,
          input.name,
          input.nip05 ?? null,
          JSON.stringify(checked.payouts),
          input.evmCredit ?? 'fast',
          input.webhookUrl ?? null,
          checked.inboxRelays,
          now,
        ],
      );
      const requestId = await this.queueFor(tx, store, 'setup', now);
      const settings = await this.settings(owner, tx);
      if (settings === undefined) {
        throw new Error(`config of ${owner} vanished while it was written`);
      }
      return { ok: true, settings, requestId };
    });
  }

  async products(owner: string, tx: Queryable = this.db): Promise<ProductRecord[]> {
    const rows = await tx.query<ProductRow>(
      `select d, title, description, summary, url, price_usd, on_sale, updated_at
       from products where owner = $1 order by d`,
      [owner],
    );
    return rows.map(toProduct);
  }

  async product(owner: string, d: string): Promise<ProductRecord | undefined> {
    const [row] = await this.db.query<ProductRow>(
      `select d, title, description, summary, url, price_usd, on_sale, updated_at
       from products where owner = $1 and d = $2`,
      [owner, d],
    );
    return row === undefined ? undefined : toProduct(row);
  }

  /**
   * Create or replace product `d`. Refused before anything is written when the
   * store's tier cap of products on sale is reached, or a coin of the draft or
   * active payouts cannot pay its price.
   */
  async putProduct(
    owner: string,
    d: string,
    input: ProductInput,
  ): Promise<{ ok: true; product: ProductRecord; requestId: string | undefined } | Refusal> {
    if (!PRODUCT_D_RE.test(d)) {
      return { ok: false, error: 'bad_product', problems: ['d: not a product id'] };
    }
    const now = this.now();
    const onSale = input.onSale ?? true;
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      const settings = await this.settings(owner, tx);
      const state = await this.ledgerState(owner, tx);
      if (store === undefined || settings === undefined || state === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (WINDING_DOWN_STATUSES.includes(store.status)) {
        return WINDING_DOWN_REFUSAL;
      }
      const [existing] = await tx.query<{ on_sale: boolean }>(
        'select on_sale from products where owner = $1 and d = $2',
        [owner, d],
      );
      if (onSale && existing?.on_sale !== true) {
        const max = store.tier?.maxProducts ?? this.pendingMaxProducts;
        const [count] = await tx.query<{ count: number }>(
          'select count(*)::int as count from products where owner = $1 and on_sale and d <> $2',
          [owner, d],
        );
        if ((count?.count ?? 0) >= max) {
          return { ok: false, error: 'product_cap', problems: [`at most ${max} products on sale`] };
        }
      }
      const payouts = [...settings.draftPayouts, ...activePayouts(state, owner)];
      const problems = priceProblems({ payouts }, [{ d, priceUsd: input.priceUsd }]);
      if (problems.length > 0) {
        return { ok: false, error: 'bad_price', problems };
      }
      await tx.query(
        `insert into products (owner, d, title, description, summary, url, price_usd, on_sale, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (owner, d) do update set title = $3, description = $4, summary = $5, url = $6,
           price_usd = $7, on_sale = $8, updated_at = $9`,
        [
          owner,
          d,
          input.title,
          input.description,
          input.summary ?? null,
          input.url ?? null,
          input.priceUsd,
          onSale,
          now,
        ],
      );
      const requestId = await this.queueFor(tx, store, 'setup', now);
      const [row] = await tx.query<ProductRow>(
        `select d, title, description, summary, url, price_usd, on_sale, updated_at
         from products where owner = $1 and d = $2`,
        [owner, d],
      );
      if (row === undefined) {
        throw new Error(`product ${d} of ${owner} vanished while it was written`);
      }
      return { ok: true, product: toProduct(row), requestId };
    });
  }

  /**
   * Stop selling product `d`: a product the ledger has a history for (a
   * listing out, or terms) stays, sold out (its row must outlive its orders);
   * one never published is removed.
   */
  async deleteProduct(
    owner: string,
    d: string,
  ): Promise<
    { ok: true; outcome: 'stopped' | 'removed'; requestId: string | undefined } | Refusal
  > {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      const state = await this.ledgerState(owner, tx);
      if (store === undefined || state === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (WINDING_DOWN_STATUSES.includes(store.status)) {
        return WINDING_DOWN_REFUSAL;
      }
      const [existing] = await tx.query('select 1 from products where owner = $1 and d = $2', [
        owner,
        d,
      ]);
      if (existing === undefined) {
        return { ok: false, error: 'not_found' };
      }
      const history =
        state.listings[d] !== undefined || state.terms.some((period) => period.terms.d === d);
      if (history) {
        await tx.query(
          'update products set on_sale = false, updated_at = $3 where owner = $1 and d = $2',
          [owner, d, now],
        );
      } else {
        await tx.query('delete from products where owner = $1 and d = $2', [owner, d]);
      }
      const requestId = await this.queueFor(tx, store, 'setup', now);
      return { ok: true, outcome: history ? 'stopped' : 'removed', requestId };
    });
  }

  /**
   * A new webhook secret, sealed, returned once: it is never stored in
   * clear, nor in a request row. The queued request only restarts the node.
   */
  async rotateWebhookSecret(
    owner: string,
  ): Promise<{ ok: true; secret: string; requestId: string | undefined } | Refusal> {
    const now = this.now();
    const secret = randomBytes(WEBHOOK_SECRET_BYTES).toString('hex');
    const sealed = this.vault.seal(Buffer.from(secret, 'utf8'), owner, 'webhook');
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      if (store === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (store.status === 'suspended') {
        return SUSPENDED_REFUSAL;
      }
      await tx.query(
        'update store_keys set webhook_secret = $2, webhook_rotated_at = $3 where owner = $1',
        [owner, sealed, now],
      );
      const requestId = await this.queueFor(tx, store, 'restart', now);
      return { ok: true, secret, requestId };
    });
  }

  /** The ledger's orders with buyer emails, hand answers and unresolved payments (from the row only). */
  async orders(owner: string): Promise<OrdersView | undefined> {
    const state = await this.ledgerState(owner);
    if (state === undefined) {
      return undefined;
    }
    const titles = new Map(
      (
        await this.db.query<{ d: string; title: string }>(
          'select d, title from products where owner = $1',
          [owner],
        )
      ).map((row) => [row.d, row.title]),
    );
    const orders = Object.values(state.orders)
      .map(
        (order): OrderView => ({
          key: order.key,
          buyerPubkey: order.buyerPubkey,
          orderId: order.orderId,
          product: order.product,
          productTitle: titles.get(orderProductD(order)) ?? null,
          createdAt: order.createdAt,
          email: order.email,
          customerRef: order.customerRef,
          reportedTxs: order.reportedTxs,
          paid:
            order.paid === undefined
              ? undefined
              : {
                  signature: order.paid.signature,
                  amount: order.paid.amount,
                  fee: order.paid.fee ?? '0',
                  caip19: order.paid.caip19,
                  medium: order.paid.medium,
                  blockTime: order.paid.blockTime,
                },
          webhook:
            order.webhook === undefined
              ? undefined
              : {
                  state: order.webhook.state,
                  attempts: order.webhook.attempts,
                  lastStatus: order.webhook.lastStatus,
                },
          deliveredAt: order.deliveredAt,
        }),
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    const answeredByHand: OrdersView['answeredByHand'] = {};
    for (const [key, answer] of Object.entries(state.answeredByHand ?? {})) {
      answeredByHand[key] = {
        kind: answer.kind,
        ...(answer.tx === undefined ? {} : { tx: answer.tx }),
        ...(answer.amount === undefined ? {} : { amount: answer.amount }),
        ...(answer.caip19 === undefined ? {} : { caip19: answer.caip19 }),
      };
    }
    return { orders, answeredByHand, unresolvedPayments: state.unresolvedPayments };
  }

  /** Queue a hand answer for order `key` (step 14 applies it on the holder). */
  async requestHandAnswer(
    owner: string,
    key: string,
    input: HandInput,
  ): Promise<{ ok: true; requestId: string } | Refusal> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      if (store === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (store.status === 'pending') {
        return { ok: false, error: 'inactive' };
      }
      if (store.status === 'suspended') {
        return SUSPENDED_REFUSAL;
      }
      const request =
        input.kind === 'complete'
          ? { kind: 'delivered' as const }
          : {
              kind: 'refunded' as const,
              tx: input.tx,
              amount: input.amount,
              ...(input.asset === undefined ? {} : { asset: input.asset }),
            };
      return {
        ok: true,
        requestId: await insertRequest(tx, owner, 'hand_answer', { key, request }, now),
      };
    });
  }

  /** Queue the store's suspension (step 15): only a store its holder serves. */
  async requestSuspend(owner: string): Promise<{ ok: true; requestId: string } | Refusal> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const store = await this.lockedStore(tx, owner);
      if (store === undefined) {
        return { ok: false, error: 'no_store' };
      }
      if (store.status === 'pending') {
        return { ok: false, error: 'inactive' };
      }
      if (WINDING_DOWN_STATUSES.includes(store.status)) {
        return WINDING_DOWN_REFUSAL;
      }
      // A second click answers with the suspension already queued.
      const [queued] = await tx.query<{ id: string }>(
        `select id from admin_requests where owner = $1 and kind = 'suspend' and state = 'pending'
         order by created_at, id limit 1`,
        [owner],
      );
      return {
        ok: true,
        requestId: queued?.id ?? (await insertRequest(tx, owner, 'suspend', {}, now)),
      };
    });
  }
}
