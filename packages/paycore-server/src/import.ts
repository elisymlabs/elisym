/**
 * `import <home>` (step 17): a self-host merchant-node store taken over by
 * this server. Read from the home: the store key S (never the owner key O),
 * the ledger, the config and the products; from the relays: O's newest payout
 * list (10133) and store authorization (30490). The store becomes `active` at
 * once on those O-signed events (stored committed and recorded), so no paid
 * order waits on the merchant; a hosted 30490 replaces the self-host one
 * later through prepare / sign / commit.
 */
import { readFileSync } from 'node:fs';
import { KIND_PAYTO, KIND_STORE_AUTH, readStoreAuth } from '@elisym/commerce';
import { WEBHOOK_MIN_SECRET_BYTES } from '@elisym/commerce/webhook';
import { type MerchantConfig, loadConfig } from '@merchant-node/config';
import { type MerchantHome, heldByRunningMerchant, merchantHome } from '@merchant-node/home';
import { type LoadedKeys, openSecret, readPassphrase } from '@merchant-node/keys';
import {
  type LedgerState,
  PRE_FEE_LEDGER_VERSION,
  UPGRADE_FIRST_PROBLEM,
  loadLedger,
} from '@merchant-node/ledger';
import { type Product, loadProducts } from '@merchant-node/products';
import { checkoutRelaySpelling } from '@merchant-node/relays';
import { lostHistoryProblem, productPriceProblems } from '@merchant-node/start-checks';
import { ownerEventTemplates } from '@merchant-node/store-events';
import { WEBHOOK_SECRET_FILE_ENV, readWebhookSecret } from '@merchant-node/webhook';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import * as z from 'zod';
import type { PaycoreConfig } from './config';
import { type Db, STORES_CHANNEL } from './db/db';
import { type KeyVault, MAX_SECRET_BYTES } from './db/keys';
import { activePayouts, railConfig, storeRails } from './node/load';
import type { OwnerEventKind } from './owner-events';
import { insertLedger } from './state/ledger-store';
import {
  ConfigInputSchema,
  ProductInputSchema,
  canonicalPayouts,
  hostedWebhookProblem,
} from './state/stores';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * O's newest event of `kind` the relays serve (for 30490, the one at the
 * store's address `d`), its signature checked; undefined when none is served
 * or none could be read. `relay/newest.ts`'s `newestOnRelays` has this shape.
 */
export type NewestOnRelays = (
  owner: string,
  kind: OwnerEventKind,
  options: { d?: string },
) => Promise<NostrEvent | undefined>;

export interface ImportOptions {
  /** The merchant-node home directory (`config.json`, `keys.json`, `ledger.json`, `products/`). */
  home: string;
  tier: string;
  /** The operator's word that the self-host node is stopped (`--node-stopped`). */
  nodeStopped: boolean;
  /** `--webhook-secret-file`: the node's webhook secret, sealed so queued webhooks keep verifying. */
  webhookSecretFile?: string;
}

export interface ImportDeps {
  db: Db;
  vault: KeyVault;
  config: Pick<PaycoreConfig, 'inboxRelays' | 'rpcs'>;
  readRelays: NewestOnRelays;
  /** Seconds. */
  now: () => number;
  /** Where the store key's passphrase is read (`ELISYM_MERCHANT_PASSPHRASE(_FILE)`). */
  env?: Readonly<Record<string, string | undefined>>;
  readFile?: (path: string) => string;
  /** Whether a running merchant holds the home (default: its `run.lock` is fresh). */
  heldByRunning?: (home: MerchantHome) => boolean;
}

export interface ImportResult {
  owner: string;
  storePubkey: string;
  tier: string;
  products: number;
  orders: number;
  webhookSecret: boolean;
  /** What the operator should know; nothing here refused the import. */
  warnings: string[];
}

/** Why the home cannot be imported; nothing was written. */
export class ImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRefused';
  }
}

const SETUP_FIRST = 'run `elisym-merchant setup` on the self-host node first';

/** `keys.json` as import reads it: the store key and both public keys; the owner key is never looked at. */
const KeysFileSchema = z.object({
  store: z.string(),
  storePubkey: z.string().regex(HEX_KEY_RE).optional(),
  ownerPubkey: z.string().regex(HEX_KEY_RE).optional(),
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `read`, turning what it throws into a refusal that names `what`. */
function refuseOnThrow<Value>(what: string, read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    if (error instanceof ImportRefused) {
      throw error;
    }
    throw new ImportRefused(`${what}: ${errorText(error)}`);
  }
}

/**
 * The store key S, opened (with the passphrase when sealed) and checked
 * against its public key, and O's public key as stored. The owner's secret is
 * never parsed, derived from or decrypted: a home whose `keys.json` does not
 * name the owner's public key (written before 0.5.0) is refused.
 */
function storeKeys(
  home: MerchantHome,
  deps: ImportDeps,
): { storeSecretKey: Uint8Array; storePubkey: string; owner: string } {
  const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const parsed = KeysFileSchema.safeParse(
    refuseOnThrow(`cannot read ${home.keys}`, () => JSON.parse(read(home.keys))),
  );
  if (!parsed.success) {
    throw new ImportRefused(`${home.keys} holds no usable store key`);
  }
  const file = parsed.data;
  if (file.ownerPubkey === undefined) {
    throw new ImportRefused(
      `${home.keys} does not name the owner public key (written before 0.5.0): run \`elisym-merchant encrypt-keys\` with a current node to rewrite it`,
    );
  }
  const storePubkey =
    file.storePubkey ??
    (HEX_KEY_RE.test(file.store) ? getPublicKey(hexToBytes(file.store)) : undefined);
  if (storePubkey === undefined) {
    throw new ImportRefused(`${home.keys} holds a sealed store key without its public key`);
  }
  // Only the store entry is filled in: nothing below can reach the owner's secret.
  const keys: LoadedKeys = {
    storePubkey,
    ownerPubkey: file.ownerPubkey,
    sealed: { store: file.store, owner: '' },
  };
  const storeSecretKey = refuseOnThrow('the store key', () =>
    openSecret(keys, 'store', readPassphrase(deps.env ?? process.env, read)),
  );
  return { storeSecretKey, storePubkey, owner: file.ownerPubkey };
}

/** The webhook secret from `--webhook-secret-file`, by merchant-node's rules (one trailing newline dropped). */
function webhookSecretFrom(path: string, deps: ImportDeps): string {
  const secret = refuseOnThrow('--webhook-secret-file', () =>
    readWebhookSecret({ [WEBHOOK_SECRET_FILE_ENV]: path }, deps.readFile),
  );
  if (secret === undefined) {
    throw new ImportRefused('--webhook-secret-file names no secret');
  }
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < WEBHOOK_MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw new ImportRefused(
      `the webhook secret must be ${WEBHOOK_MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes`,
    );
  }
  return secret;
}

/** The imported ledger: one a setup pass of this version ran on, with a recorded payout list. */
function importedLedger(home: MerchantHome, owner: string): LedgerState {
  const loaded = refuseOnThrow(`cannot read ${home.ledger}`, () => loadLedger(home.ledger));
  if (loaded.read === 'missing') {
    throw new ImportRefused(`${home.ledger} does not exist: ${SETUP_FIRST}`);
  }
  if (loaded.read === PRE_FEE_LEDGER_VERSION) {
    throw new ImportRefused(`${home.ledger}: ${UPGRADE_FIRST_PROBLEM}`);
  }
  if (loaded.state.payto === undefined) {
    throw new ImportRefused(`the ledger records no published payout list: ${SETUP_FIRST}`);
  }
  refuseOnThrow('the ledger', () => activePayouts(loaded.state, owner));
  return loaded.state;
}

/** Each product as the admin API would take it (`PUT products/:d`): refused with every problem. */
function checkedProducts(products: ReadonlyMap<string, Product>): void {
  const problems: string[] = [];
  for (const [d, product] of products) {
    const input = ProductInputSchema.safeParse({
      title: product.title,
      description: product.description,
      ...(product.summary === undefined ? {} : { summary: product.summary }),
      ...(product.url === undefined ? {} : { url: product.url }),
      priceUsd: product.priceUsd,
      onSale: product.onSale,
    });
    if (!input.success) {
      problems.push(
        ...input.error.issues.map(
          (issue) => `products/${d}: ${issue.path.join('.') || 'product'} ${issue.message}`,
        ),
      );
    }
  }
  if (problems.length > 0) {
    throw new ImportRefused(`the products are not usable here:\n- ${problems.join('\n- ')}`);
  }
}

/** The evm credit the store runs with: `safe` when any configured chain asked for it. */
function evmCreditOf(config: MerchantConfig): 'fast' | 'safe' {
  return Object.values(config.evm ?? {}).some((chain) => chain?.credit === 'safe')
    ? 'safe'
    : 'fast';
}

/**
 * What the config would be refused for in `PUT store/config`, where it applies
 * to a store already published: inbox relays outside the allowlist, a webhook
 * URL that is not https on port 443 to a public host, a name or nip05 that
 * cannot be stored, a chain of the payouts or standing terms with no operator
 * RPC. Payouts need no wallet signature here (they are live already).
 */
function configProblems(
  config: MerchantConfig,
  state: LedgerState,
  owner: string,
  deps: ImportDeps,
): { problems: string[]; inboxRelays: string[] } {
  const problems: string[] = [];
  const input = ConfigInputSchema.safeParse({
    name: config.name,
    ...(config.nip05 === undefined ? {} : { nip05: config.nip05 }),
    payouts: config.payouts,
    inboxRelays: config.inboxRelays,
  });
  if (!input.success) {
    problems.push(
      ...input.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`),
    );
  }
  const inboxRelays = [
    ...new Set(config.inboxRelays.map((relay) => checkoutRelaySpelling(relay) ?? relay)),
  ];
  for (const relay of inboxRelays) {
    if (!deps.config.inboxRelays.includes(relay)) {
      problems.push(
        `inboxRelays: ${relay} is not a relay this server allows (${deps.config.inboxRelays.join(', ')}); move the store's inbox there and run setup on the node first`,
      );
    }
  }
  if (config.webhook !== undefined) {
    const problem = hostedWebhookProblem(config.webhook.url);
    if (problem !== undefined) {
      problems.push(`webhook.url: ${problem}`);
    }
  }
  const rails = storeRails(
    [...activePayouts(state, owner), ...config.payouts],
    state.terms ?? [],
    config.network,
    deps.now(),
  );
  for (const rail of railConfig(config.network, rails, deps.config.rpcs, 'fast').unavailable) {
    problems.push(`payouts: this server has no RPC for ${rail}`);
  }
  return { problems, inboxRelays };
}

/**
 * The relays' newest 10133 and 30490 by O: the payout list must be the one
 * the ledger recorded (dated `state.payto.createdAt`, paying exactly its
 * payouts), the authorization must stand for S.
 */
async function relaysOwnerEvents(
  owner: string,
  storePubkey: string,
  state: LedgerState,
  deps: ImportDeps,
): Promise<{ payoutList: NostrEvent; authorization: NostrEvent }> {
  const recorded = state.payto;
  if (recorded === undefined) {
    throw new ImportRefused(`the ledger records no published payout list: ${SETUP_FIRST}`);
  }
  const payoutList = await deps.readRelays(owner, KIND_PAYTO, {});
  if (payoutList === undefined) {
    throw new ImportRefused(`the relays serve no payout list by this owner: ${SETUP_FIRST}`);
  }
  if (!genuine(payoutList, owner, KIND_PAYTO)) {
    throw new ImportRefused('the payout list the relays serve is not signed by the owner');
  }
  if (payoutList.created_at !== recorded.createdAt) {
    throw new ImportRefused(
      `the relays' newest payout list is dated ${payoutList.created_at}, the ledger recorded one dated ${recorded.createdAt}: ${SETUP_FIRST}`,
    );
  }
  const expected = ownerEventTemplates(
    { payouts: activePayouts(state, owner) },
    owner,
    storePubkey,
    recorded.createdAt,
    recorded.createdAt,
    { mode: 'self-host' },
  ).payoutList;
  if (
    JSON.stringify(payoutList.tags) !== JSON.stringify(expected.tags) ||
    payoutList.content !== expected.content
  ) {
    throw new ImportRefused(
      `the relays' newest payout list does not pay the payouts the ledger recorded: ${SETUP_FIRST}`,
    );
  }
  const authorization = await deps.readRelays(owner, KIND_STORE_AUTH, { d: storePubkey });
  if (authorization === undefined || !genuine(authorization, owner, KIND_STORE_AUTH)) {
    throw new ImportRefused(
      `the relays serve no authorization of this store key by the owner: ${SETUP_FIRST}`,
    );
  }
  const auth = readStoreAuth(authorization, storePubkey, deps.now());
  if (auth.status !== 'active') {
    throw new ImportRefused(
      `the owner's newest authorization of this store key is ${auth.status}: the store cannot take orders`,
    );
  }
  return { payoutList, authorization };
}

function genuine(event: NostrEvent, owner: string, kind: OwnerEventKind): boolean {
  return (
    event.pubkey === owner &&
    event.kind === kind &&
    verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
  );
}

/** The event as stored in `owner_events`: its seven fields only. */
function plainEvent(event: NostrEvent): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}

/**
 * Import a stopped self-host store: refused, with nothing written, unless the
 * operator says the node is stopped and its lock is not fresh, the owner has
 * no store here yet (R1), the tier exists and holds its products on sale, the
 * config passes this server's rules, and the relays' newest payout list is the
 * one the ledger recorded. One transaction writes the store `active`, its
 * sealed keys, config (draft payouts = the config's payouts; the node's RPC
 * URLs dropped), products, ledger and the two owner events, committed and
 * recorded (the 10133 with the ledger's own payouts string, P9).
 */
export async function importStore(options: ImportOptions, deps: ImportDeps): Promise<ImportResult> {
  if (!options.nodeStopped) {
    throw new ImportRefused(
      'stop the self-host node first and say so with --node-stopped: two nodes on one store send every reply and webhook twice',
    );
  }
  const home = merchantHome(options.home, {});
  if ((deps.heldByRunning ?? ((held) => heldByRunningMerchant(held)))(home)) {
    throw new ImportRefused(
      `a running merchant node holds ${home.dir} (its run.lock is fresh): stop it, then wait 90 s after it stopped`,
    );
  }
  const { storeSecretKey, storePubkey, owner } = storeKeys(home, deps);
  const [existing] = await deps.db.query<{ owner: string }>(
    'select owner from stores where owner = $1 or store_pubkey = $2',
    [owner, storePubkey],
  );
  if (existing !== undefined) {
    throw new ImportRefused(
      existing.owner === owner
        ? 'this owner already has a store on this server (one store per owner key)'
        : 'this store key already belongs to another store on this server',
    );
  }
  const [tier] = await deps.db.query<{ max_products: number }>(
    'select max_products from tiers where name = $1',
    [options.tier],
  );
  if (tier === undefined) {
    throw new ImportRefused(`no such tier: ${options.tier}`);
  }
  const config = refuseOnThrow('config.json', () => loadConfig(home.config));
  const state = importedLedger(home, owner);
  const products = refuseOnThrow('products', () => loadProducts(home.products));
  checkedProducts(products);
  const onSale = [...products.values()].filter((product) => product.onSale).length;
  if (onSale > tier.max_products) {
    throw new ImportRefused(
      `the store sells ${onSale} products and tier ${options.tier} allows ${tier.max_products}: pick a larger tier`,
    );
  }
  const lost = lostHistoryProblem(state, products);
  if (lost !== undefined) {
    throw new ImportRefused(lost);
  }
  const prices = productPriceProblems({ payouts: activePayouts(state, owner) }, products.values());
  if (prices !== undefined) {
    throw new ImportRefused(prices);
  }
  const checked = configProblems(config, state, owner, deps);
  if (checked.problems.length > 0) {
    throw new ImportRefused(`config.json is not usable here:\n- ${checked.problems.join('\n- ')}`);
  }
  const webhookSecret =
    options.webhookSecretFile === undefined
      ? undefined
      : webhookSecretFrom(options.webhookSecretFile, deps);
  const draft = canonicalPayouts(config.payouts);
  if (draft === undefined) {
    throw new ImportRefused('config.json holds no payouts');
  }
  const recorded = state.payto;
  if (recorded === undefined) {
    throw new ImportRefused(`the ledger records no published payout list: ${SETUP_FIRST}`);
  }
  const { payoutList, authorization } = await relaysOwnerEvents(owner, storePubkey, state, deps);

  const warnings: string[] = [];
  if (draft.text !== recorded.payouts) {
    warnings.push(
      "config.json's payouts differ from the published payout list: they are kept as the draft; the published list stays active until the merchant signs a new one",
    );
  }
  if (config.webhook !== undefined && webhookSecret === undefined) {
    warnings.push(
      'the store has a webhook and no --webhook-secret-file: webhooks queue unsent (the store runs degraded) until the merchant sets a new secret',
    );
  }
  const now = deps.now();
  const sealedStore = deps.vault.seal(storeSecretKey, owner, 'store');
  storeSecretKey.fill(0);
  const sealedWebhook =
    webhookSecret === undefined
      ? null
      : deps.vault.seal(Buffer.from(webhookSecret, 'utf8'), owner, 'webhook');
  await deps.db.transaction(async (tx) => {
    const inserted = await tx.query(
      `insert into stores (owner, store_pubkey, status, tier, plan_source, created_at)
       values ($1, $2, 'active', $3, 'operator', $4) on conflict do nothing returning 1`,
      [owner, storePubkey, options.tier, now],
    );
    if (inserted.length === 0) {
      throw new ImportRefused('this owner or store key got a store on this server meanwhile');
    }
    await tx.query(
      `insert into store_keys (owner, store_key, webhook_secret, webhook_rotated_at)
       values ($1, $2, $3, $4)`,
      [owner, sealedStore, sealedWebhook, sealedWebhook === null ? null : now],
    );
    await tx.query(
      `insert into store_config (owner, name, nip05, network, draft_payouts, evm_credit, webhook_url,
         inbox_relays, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [
        owner,
        config.name,
        config.nip05 ?? null,
        config.network,
        draft.text,
        evmCreditOf(config),
        config.webhook?.url ?? null,
        checked.inboxRelays,
        now,
      ],
    );
    for (const product of products.values()) {
      await tx.query(
        `insert into products (owner, d, title, description, summary, url, price_usd, on_sale, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          owner,
          product.d,
          product.title,
          product.description,
          product.summary ?? null,
          product.url ?? null,
          product.priceUsd,
          product.onSale,
          now,
        ],
      );
    }
    await insertLedger(tx, owner, state, now);
    for (const event of [payoutList, authorization]) {
      await tx.query(
        `insert into owner_events (id, owner, kind, event, payouts_string, committed_at, recorded,
           published_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, true, $6)`,
        [
          event.id,
          owner,
          event.kind,
          JSON.stringify(plainEvent(event)),
          event.kind === KIND_PAYTO ? recorded.payouts : null,
          now,
        ],
      );
    }
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
  });
  return {
    owner,
    storePubkey,
    tier: options.tier,
    products: products.size,
    orders: Object.keys(state.orders).length,
    webhookSecret: webhookSecret !== undefined,
    warnings,
  };
}
