/**
 * elisym merchant node. `init` makes the home (config template and keys),
 * `setup` checks the inbox relays and publishes the store, `run` takes orders,
 * verifies payments by the direct-mode contract and completes the orders.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { splitNip05 } from '@elisym/commerce';
import { createSolanaRpc } from '@solana/kit';
import { SimplePool } from 'nostr-tools/pool';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { ADMIN_HOST, DEFAULT_ADMIN_PORT, isAdminPort, startAdminServer } from './admin-server';
import {
  type RelayView,
  checkDomain,
  checkInboxRelays,
  offerProblems,
  profileFeeSupport,
  readBeforeSetup,
  readRelayViews,
} from './checks';
import {
  type MerchantConfig,
  configTemplate,
  hasSolanaRail,
  loadConfig,
  priceProblems,
  tempoRegistryNetwork,
} from './config';
import { CATCH_UP_INTERVAL_MS, OFFER_RELAYS, SOLANA_MEDIUMS, WEBHOOK_TICK_MS } from './constants';
import { deliverOrder, publishSelfCopy } from './deliver';
import {
  TreasuryReader,
  type TreasuryRefresh,
  feeConfigRpcUrl,
  feeDeclaration,
  profileFeeWarning,
} from './fee';
import { type HandRequest, applyHandAnswer, buildHandAnswer, planHandAnswer } from './hand';
import { handOutcome, publishHandAnswer } from './hand-publish';
import {
  type MerchantHome,
  encryptHomeKeys,
  ensureHome,
  heldByRunningMerchant,
  initKeys,
  loadKeys,
  merchantHome,
  takeLock,
} from './home';
import { storeIdentity } from './intake';
import {
  PASSPHRASE_HINT,
  STORE_KEY_WARNING,
  encryptionNotes,
  openSecret,
  openSetupKeys,
  openCheckKeys,
  readPassphrase,
  storeKeyForAdmin,
} from './keys';
import {
  type LedgerState,
  type WebhookOutbox,
  openLedger,
  openLedgerForUpgrade,
  saveLedger,
} from './ledger';
import { InboxListener } from './listener';
import { printable } from './printable';
import {
  PRODUCT_FILE,
  type Product,
  intakeProductIds,
  loadProducts,
  productTemplateText,
  uneditedProducts,
} from './products';
import { setupPublisher } from './publish';
import { MerchantRuntime } from './runtime';
import { SelfCopies } from './self-copies';
import {
  historyRefusal,
  payoutListDate,
  planListings,
  publishAndRecord,
  setupClockProblems,
} from './setup-ledger';
import { buildStoreWideEvents, productNaddr, storeNostrJson } from './store-events';
import { tempoContextFor } from './tempo';
import { standingTerms } from './terms';
import {
  type WebhookTarget,
  WEBHOOK_SECRET_HINT,
  WebhookSender,
  applySendResult,
  orderPaidBody,
  outcomeText,
  readWebhookSecret,
  sendWebhook,
  testBody,
  webhookTarget,
} from './webhook';
import { type RearmKind, orderLines, rearmWebhook } from './webhook-commands';

const USAGE = `usage: elisym-merchant <command> [--home <dir>]

  init [--network devnet|mainnet]
         make the home: a config.json and products/my-product/PRODUCT.md to edit,
         and the store's keys
  setup  check the inbox relays and publish the store: every product in products/
         (one directory each), republishing only what changed
  run    take orders, verify payments, complete them
  orders list the orders: paid, completed, the buyer's email, the customer
         reference, the webhook state and its event id
  check  check the inbox relays, the owner's payout list and the domain
  encrypt-keys [--owner-only]
         encrypt the keys in keys.json with $ELISYM_MERCHANT_PASSPHRASE
         (or the file $ELISYM_MERCHANT_PASSPHRASE_FILE names); both keys by default
  store-key [--yes]
         print the store's secret key, for the admin page on this machine
  admin [--port <port>]
         serve the admin page on 127.0.0.1 (default port ${DEFAULT_ADMIN_PORT}): paste the
         store key there to see the orders your inbox relays hold
  complete <buyer>:<orderId> [--yes]
         answer an unpaid order by hand: close it and send "completed"
  refund <buyer>:<orderId> --tx <refund tx> --amount <subunits> [--asset <caip19>] [--yes]
         answer an unpaid order by hand with a refund you already sent
         (--asset: the refunded coin; required when the store has several payouts,
         and ignored, with a warning, when re-sending an answer kept without one)
         (both need the node stopped; --yes skips the confirmation)
  webhook test
         send a signed test event to config.json's webhook (it credits nothing)
  webhook retry <buyer>:<orderId>
         send a pending or failed order.paid webhook again now, with a fresh deadline
  webhook resend <buyer>:<orderId>
         send the order.paid webhook of any paid order again (receivers dedupe on its
         event id); retry and resend need the node stopped

The home is --home, else $ELISYM_MERCHANT_HOME, else ~/.elisym-merchant.
It holds the store's secret keys: keep it private and back it up. init encrypts
new keys when $ELISYM_MERCHANT_PASSPHRASE (or ..._FILE) is set (--owner-only:
the owner key only); a command that needs an encrypted key reads it from there.
A webhook in config.json needs its secret in $ELISYM_MERCHANT_WEBHOOK_SECRET
(or the file $ELISYM_MERCHANT_WEBHOOK_SECRET_FILE names), at least 32 bytes.`;

/** Answers a relay's NIP-42 challenge with the store key. */
function storeAuth(storeSecretKey: Uint8Array) {
  return async (template: EventTemplate) => finalizeEvent(template, storeSecretKey);
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This package's version, for the webhook's User-Agent (src/ and dist/ sit beside package.json). */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof read.version === 'string' ? read.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USER_AGENT = `elisym-merchant-node/${packageVersion()}`;

interface Args {
  command: string | undefined;
  /** `webhook`'s own command: test, retry or resend. */
  subcommand: string | undefined;
  /** The order key of `complete` / `refund` / `webhook retry` / `webhook resend`. */
  target: string | undefined;
  home: string | undefined;
  network: string | undefined;
  tx: string | undefined;
  amount: string | undefined;
  asset: string | undefined;
  port: string | undefined;
  yes: boolean;
  ownerOnly: boolean;
}

const VALUE_FLAGS = {
  '--home': 'home',
  '--network': 'network',
  '--tx': 'tx',
  '--amount': 'amount',
  '--asset': 'asset',
  '--port': 'port',
} as const;

const DELIVER_RENAMED =
  'deliver was renamed complete in 0.9.0: complete <buyer>:<orderId> (the node sends no delivery)';

function isValueFlag(arg: string): arg is keyof typeof VALUE_FLAGS {
  return arg in VALUE_FLAGS;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: undefined,
    subcommand: undefined,
    target: undefined,
    home: undefined,
    network: undefined,
    tx: undefined,
    amount: undefined,
    asset: undefined,
    port: undefined,
    yes: false,
    ownerOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== undefined && isValueFlag(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      args[VALUE_FLAGS[arg]] = value;
      index += 1;
    } else if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--owner-only') {
      args.ownerOnly = true;
    } else if (args.command === undefined && arg !== undefined && !arg.startsWith('--')) {
      args.command = arg;
    } else if (
      args.command === 'webhook' &&
      args.subcommand === undefined &&
      arg !== undefined &&
      !arg.startsWith('--')
    ) {
      args.subcommand = arg;
    } else if (
      args.command === 'webhook' &&
      (args.subcommand === 'retry' || args.subcommand === 'resend') &&
      args.target === undefined &&
      arg !== undefined &&
      !arg.startsWith('--')
    ) {
      args.target = arg;
    } else if (
      (args.command === 'complete' || args.command === 'refund') &&
      args.target === undefined &&
      arg !== undefined &&
      !arg.startsWith('--')
    ) {
      args.target = arg;
    } else if (args.command === 'deliver') {
      throw new Error(DELIVER_RENAMED);
    } else {
      throw new Error(`unknown argument ${arg ?? ''}`);
    }
  }
  if (args.command === 'deliver') {
    throw new Error(DELIVER_RENAMED);
  }
  return args;
}

function init(home: MerchantHome, network: string | undefined, ownerOnly: boolean): void {
  if (network !== undefined && network !== 'devnet' && network !== 'mainnet') {
    throw new Error('--network is devnet or mainnet');
  }
  // The passphrase is read and checked before anything is created: a failing
  // init never leaves a home with a config and no keys.
  const passphrase = readPassphrase();
  if (ownerOnly && passphrase === undefined) {
    throw new Error(`--owner-only encrypts the owner key: ${PASSPHRASE_HINT}`);
  }
  ensureHome(home);
  if (existsSync(home.config)) {
    console.log(`config  ${home.config} (kept)`);
  } else {
    writeFileSync(
      home.config,
      `${JSON.stringify(configTemplate(network === 'mainnet' ? 'mainnet' : 'devnet'), null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    console.log(`config  ${home.config} (edit it)`);
  }
  if (existsSync(home.products)) {
    console.log(`product ${home.products} (kept)`);
  } else {
    const example = join(home.products, 'my-product');
    mkdirSync(example, { recursive: true, mode: 0o700 });
    writeFileSync(join(example, PRODUCT_FILE), productTemplateText(), {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`product ${join(example, PRODUCT_FILE)} (edit it: one directory per product)`);
  }
  const { keys, created, keptPlain } = initKeys(home, passphrase, ownerOnly);
  console.log(`store   ${keys.storePubkey}`);
  console.log(`owner   ${keys.ownerPubkey}`);
  if (created && passphrase !== undefined) {
    console.log(`keys    encrypted (${ownerOnly ? 'the owner key only' : 'both keys'})`);
    for (const note of encryptionNotes(ownerOnly)) {
      console.log(`note    ${note}`);
    }
  }
  if (created && passphrase === undefined) {
    console.log(
      `keys    plain (no passphrase set; ${PASSPHRASE_HINT} before init to encrypt them)`,
    );
  }
  if (keptPlain) {
    console.log(
      `keys    kept plain: run encrypt-keys${ownerOnly ? ' --owner-only' : ''} to encrypt them`,
    );
  }
  console.log('next    edit config.json and the product, then run setup');
  console.log(
    'note    to tell your backend about payments, add "webhook" to config.json and a secret: openssl rand -hex 32',
  );
}

/**
 * Print what the inbox relays can do; the ones that do not take and serve gift
 * wraps for any key. Every one must: buyers send orders to all of them, and a
 * completed status one of them took counts toward the two it wants.
 */
async function reportInboxRelays(
  pool: SimplePool,
  config: MerchantConfig,
  storeSecretKey: Uint8Array,
): Promise<string[]> {
  const reader = new SimplePool();
  let verdicts: Awaited<ReturnType<typeof checkInboxRelays>>;
  try {
    verdicts = await checkInboxRelays(
      pool,
      reader,
      config.inboxRelays,
      storeSecretKey,
      storeAuth(storeSecretKey),
      log,
      nowSecs(),
    );
  } finally {
    reader.destroy();
  }
  for (const verdict of verdicts) {
    let state = 'refuses gift wraps for any key';
    if (verdict.serves) {
      state = 'ok';
    } else if (verdict.accepts) {
      state = 'takes gift wraps but does not serve them back';
    }
    console.log(`relay   ${verdict.relay}: ${state}`);
  }
  console.log(
    'note    each inbox relay must keep gift wraps (kind 1059) for at least two days past their date',
  );
  return verdicts.filter((verdict) => !verdict.serves).map((verdict) => verdict.relay);
}

/** Write the nostr.json a level A domain serves, and check it once; nothing for level C. */
async function reportDomain(
  home: MerchantHome,
  config: MerchantConfig,
  nostrJson: { names: Record<string, string> },
  /** Whether the owner key was opened here: only then is nostr.json written. */
  write = true,
): Promise<void> {
  const split = config.nip05 === undefined ? undefined : splitNip05(config.nip05);
  if (split === undefined) {
    console.log('level   C (no nip05)');
    return;
  }
  if (split.local !== '_') {
    // commerce vouches for a store at level A only under the domain-wide name.
    console.log('level   C: a named nip05 is not domain-wide; use _@domain or a bare domain for A');
    return;
  }
  if (write) {
    writeFileSync(home.nostrJson, `${JSON.stringify(nostrJson)}\n`);
    console.log(
      `nostr   serve ${home.nostrJson} at https://${split.domain}/.well-known/nostr.json with "Access-Control-Allow-Origin: *"`,
    );
  } else {
    console.log(
      `nostr   not written: the owner key is encrypted; run check again with the passphrase (${PASSPHRASE_HINT}) to write it`,
    );
  }
  const verdict = await checkDomain(split.domain, nostrJson);
  console.log(
    verdict.ok
      ? `level   A: ${verdict.url} serves it`
      : `level   C until ${verdict.url} serves it: ${verdict.problem ?? ''}`,
  );
}

/**
 * The home's config and products, checked together: a payout must be able to
 * carry every product's price. Throws with every problem found.
 */
function loadStore(home: MerchantHome): { config: MerchantConfig; products: Map<string, Product> } {
  const config = loadConfig(home.config);
  const products = loadProducts(home.products);
  const problems = priceProblems(config, products.values());
  if (problems.length > 0) {
    throw new Error(`the products are not usable:\n- ${problems.join('\n- ')}`);
  }
  return { config, products };
}

/** The reader of the elisym fee config over the config RPC (see `feeConfigRpcUrl`). */
function treasuryReader(config: MerchantConfig): TreasuryReader {
  return new TreasuryReader(createSolanaRpc(feeConfigRpcUrl(config)), config.network);
}

/** Warn (never refuse) when the store profile buyers read does not declare fee support. */
function warnProfile(views: readonly RelayView[], refresh: TreasuryRefresh): void {
  const { found, feeSupport } = profileFeeSupport(views);
  const warning = profileFeeWarning(
    found,
    feeSupport,
    refresh.kind === 'read' ? refresh.feeBps : undefined,
  );
  if (warning !== undefined) {
    log(`warning: ${warning}`);
  }
}

/** Refuse a home whose ledger has a history for a product with no directory (see `historyRefusal`). */
function refuseLostHistory(state: LedgerState, products: ReadonlyMap<string, Product>): void {
  const refusal = historyRefusal(state, products);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
}

async function setup(home: MerchantHome): Promise<void> {
  // A running merchant rewrites the whole ledger from memory: new terms written
  // under it would be lost, and the old price or payout would stay payable. The
  // lock is held for the whole setup, so a merchant cannot start in between.
  takeLock(home);
  const { config, products } = loadStore(home);
  if (products.size === 0) {
    throw new Error(
      `no products: add one as ${join(home.products, '<id>', PRODUCT_FILE)} (init scaffolds one)`,
    );
  }
  const unedited = uneditedProducts(products.values());
  if (unedited.length > 0) {
    throw new Error(
      `these products are still the init example: ${unedited.map((product) => product.file).join(', ')}. Set the title and description.`,
    );
  }
  // Both secrets first, before anything is checked, signed or published: a
  // missing or wrong passphrase must never leave a half-published store.
  const loaded = loadKeys(home);
  const keys = openSetupKeys(loaded, readPassphrase());
  // Converted to this version and saved before any relay or chain is
  // contacted: from here an older node refuses this home.
  const state = openLedgerForUpgrade(home.ledger, (read) => refuseLostHistory(read, products));
  // Only a node that can judge split payments declares fee support: the config
  // RPC's cluster is checked and the treasuries are read and saved before
  // anything is published.
  const declaration = feeDeclaration(
    state,
    config.network,
    await treasuryReader(config).refresh(state, nowSecs()),
  );
  saveLedger(home.ledger, state);
  if (declaration.warning !== undefined) {
    console.log(`warning ${declaration.warning}`);
  }
  const pool = new SimplePool();
  try {
    const failing = await reportInboxRelays(pool, config, keys.storeSecretKey);
    if (failing.length > 0) {
      throw new Error(
        `these inbox relays do not take and serve gift wraps for any key: ${failing.join(', ')}. Replace them in config.json.`,
      );
    }
    const relays = [...new Set([...OFFER_RELAYS, ...config.inboxRelays])];
    // New terms start before the first publish: a buyer may read them at once.
    const startedAt = nowSecs();
    const payouts = JSON.stringify(config.payouts);
    const { payoutList: newestList, listings: served } = await readBeforeSetup(
      pool,
      relays,
      OFFER_RELAYS,
      loaded,
      [...new Set([...products.keys(), ...Object.keys(state.listings)])],
    );
    const paytoCreatedAt = payoutListDate(state, payouts, newestList?.created_at, startedAt);
    const plans = planListings(state, products.values(), config.payouts, served, startedAt);
    const clock = setupClockProblems(state, plans, paytoCreatedAt, startedAt);
    if (clock.length > 0) {
      throw new Error(clock.join('; '));
    }
    const wide = buildStoreWideEvents(config, keys, startedAt, paytoCreatedAt, declaration.declare);
    const publisher = setupPublisher(
      pool,
      relays,
      OFFER_RELAYS,
      storeAuth(keys.storeSecretKey),
      log,
    );
    const outcomes = await publishAndRecord(state, {
      plans,
      payouts: config.payouts,
      storeSecretKey: keys.storeSecretKey,
      wide,
      publish: publisher.publish,
      payoutList: { createdAt: paytoCreatedAt, payouts },
      startedAt,
      now: nowSecs,
    });
    const { missedDefaults } = publisher;
    // Orders can come from the moment the store is published: a later first run
    // reads back from here, not from its own start.
    state.resumeAt ??= startedAt;
    saveLedger(home.ledger, state);
    console.log(`store   ${loaded.storePubkey}`);
    console.log(`owner   ${loaded.ownerPubkey}`);
    console.log(
      `fee     ${declaration.declare ? 'protocol-fee support declared' : 'protocol-fee support NOT declared (see the warning above)'}`,
    );
    const hints = config.inboxRelays.slice(0, 2);
    for (const outcome of outcomes) {
      const selling = outcome.onSale ? 'on sale' : 'stopped';
      const what = { out: 'published', unchanged: 'unchanged', failed: 'failed' }[outcome.listing];
      console.log(
        `product ${outcome.d} ${selling} ${what} ${productNaddr(loaded.storePubkey, outcome.d, hints)}`,
      );
    }
    await reportDomain(
      home,
      config,
      storeNostrJson(config, loaded.storePubkey, loaded.ownerPubkey),
    );
    // Buyers send orders to the inbox list: one that did not go out may leave them
    // writing to relays the node no longer reads.
    if (missedDefaults.length > 0) {
      throw new Error(
        `${missedDefaults.join(', ')} reached none of the default relays: buyers may see part of the change (the ledger follows what they see). Run setup again.`,
      );
    }
  } finally {
    pool.destroy();
  }
}

/**
 * Refuse to run when the relays offer buyers something this node does not
 * honour (see `offersNotHonoured`): a buyer could pay it and never get the order completed.
 */
async function refuseOffersNotHonoured(
  pool: SimplePool,
  config: MerchantConfig,
  pubkeys: { storePubkey: string; ownerPubkey: string },
  state: LedgerState,
  products: ReadonlyMap<string, Product>,
): Promise<RelayView[]> {
  // Judged twice: from the default relays, which every page reads, and with the
  // store's own inbox relays too, which a page reads when its naddr hints them.
  const views = [OFFER_RELAYS, [...new Set([...OFFER_RELAYS, ...config.inboxRelays])]];
  const read = await readRelayViews(pool, views, pubkeys, [...products.keys()]);
  const { problems, served } = offerProblems(
    read,
    config.inboxRelays,
    config.network,
    standingTerms(state.terms),
    config.tempo === undefined ? undefined : tempoRegistryNetwork(config.tempo.network),
  );
  if (problems.length > 0) {
    throw new Error(
      `the relays offer buyers what this node does not honour: ${problems.join('; ')}. Run setup (it publishes what the products name and records it) before taking orders.`,
    );
  }
  if (!served) {
    log(
      'warning: no relay served a listing or the payout list; run setup if the store is not published',
    );
  }
  return read;
}

/** A stop request's exit code (128 + the signal's number). */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/** Stop at once on a signal (the lock is released on exit). */
function stopOnSignals(): void {
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.once(signal, () => process.exit(code));
  }
}

/**
 * Hold a stop request until the ledger is written: stopping between publishing
 * and recording would leave buyers offered terms the ledger refuses. A second
 * request stops at once. Returns the code to exit with afterwards, if any.
 */
function deferSignals(): () => number | undefined {
  let requested: number | undefined;
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      if (requested !== undefined) {
        process.exit(code);
      }
      requested = code;
      console.error('stopping once the ledger is written (again to stop now)');
    });
  }
  return () => requested;
}

async function run(home: MerchantHome): Promise<void> {
  const { config, products } = loadStore(home);
  // Before the lock and any relay: a configured webhook without its secret never runs.
  const { target, warning, notice } = webhookTarget(config.webhook, readWebhookSecret());
  if (warning !== undefined) {
    log(`warning: ${warning}`);
  }
  if (notice !== undefined) {
    log(`notice: ${notice}`);
  }
  const loaded = loadKeys(home);
  const storeSecretKey = openSecret(loaded, 'store', readPassphrase());
  const storePubkey = loaded.storePubkey;
  takeLock(home);
  // Pings find a half-open socket, which would otherwise never close.
  const pool = new SimplePool({ enablePing: true });
  // Converted to this version and saved before any relay or chain is
  // contacted: from here an older node refuses this home. Only setup declares
  // fee support; run converts and publishes nothing.
  const state = openLedgerForUpgrade(home.ledger, (read) => refuseLostHistory(read, products));
  const views = await refuseOffersNotHonoured(pool, config, loaded, state, products);
  // The config RPC's cluster is checked before any of its answers is used: a
  // mismatch stops the node, an endpoint down is asked again every sweep.
  const treasuries = treasuryReader(config);
  const firstRead = await treasuries.refresh(state, nowSecs());
  if (firstRead.kind === 'wrong_cluster') {
    throw new Error(firstRead.problem);
  }
  if (firstRead.kind === 'unreachable') {
    log(
      `warning: the elisym fee config could not be read (${firstRead.problem}); asked again every sweep`,
    );
  }
  saveLedger(home.ledger, state);
  warnProfile(views, firstRead);

  // One queue: every ledger change happens in order, and is saved before anything is sent.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      log(`error: ${errorText(error)}`);
    });
  };

  // Payments verified from now on queue their webhook in the save that records them.
  const outbox: WebhookOutbox | undefined =
    target === undefined ? undefined : { storePubkey, now: nowSecs };
  const tempoContext = tempoContextFor(config, storePubkey);
  const tempo =
    tempoContext === undefined
      ? undefined
      : { ...tempoContext, now: nowSecs, ...(outbox === undefined ? {} : { outbox }) };
  const mediums = [
    ...(hasSolanaRail(config) ? [SOLANA_MEDIUMS[config.network]] : []),
    ...(tempo === undefined ? [] : [tempo.medium]),
  ];
  // The store's copies of its replies go to every inbox relay, whichever took the buyer copy.
  const selfCopies = new SelfCopies({
    publish: publishSelfCopy({
      pool,
      inboxRelays: config.inboxRelays,
      auth: storeAuth(storeSecretKey),
      log,
    }),
    log,
  });
  process.on('exit', () => {
    if (selfCopies.pending > 0) {
      log(
        `${selfCopies.pending} copy(ies) for the admin lost: the node stopped before sending them`,
      );
    }
  });
  const store = storeIdentity(storePubkey, intakeProductIds(products), mediums);
  const runtime = new MerchantRuntime({
    state,
    store,
    storeSecretKey,
    // With no Solana payout the Solana catch-up has no terms to scan and reads nothing.
    context: {
      rpc: createSolanaRpc(config.rpcUrl ?? 'https://api.devnet.solana.com'),
      network: config.network,
      now: nowSecs,
      ...(outbox === undefined ? {} : { outbox }),
    },
    ...(tempo === undefined ? {} : { tempo }),
    // No Solana payout configured: the Solana sweep reads nothing (no cluster to guess).
    ...(hasSolanaRail(config) ? {} : { catchUp: async () => ({ paid: [], incomplete: [] }) }),
    refreshTreasuries: () => treasuries.refresh(state, nowSecs()),
    stop: () => process.exit(1),
    save: () => saveLedger(home.ledger, state),
    // Completion needs no product: the status carries only the receipt.
    deliver: async (order, skip) =>
      await deliverOrder(
        {
          pool,
          inboxRelays: config.inboxRelays,
          storeSecretKey,
          auth: storeAuth(storeSecretKey),
          log,
          now: nowSecs,
        },
        order,
        skip,
      ),
    selfCopies,
    inboxRelayCount: config.inboxRelays.length,
    log,
    now: nowSecs,
    later: (ms, task) => {
      setTimeout(() => enqueue(task), ms);
    },
  });
  const startedAt = nowSecs();

  const listener = new InboxListener({
    pool,
    storePubkey,
    auth: storeAuth(storeSecretKey),
    onWrap: (wrap) => {
      if (runtime.admit(wrap)) {
        enqueue(() => runtime.handleWrap(wrap));
      }
    },
    log,
    now: nowSecs,
  });
  // Resume from the last moment every inbox relay was read through. Recorded before
  // listening, so a run that never reads every relay through does not restart "from now".
  state.resumeAt = Math.min(state.resumeAt ?? startedAt, startedAt);
  saveLedger(home.ledger, state);
  const resumeFrom = state.resumeAt;
  for (const relay of config.inboxRelays) {
    listener.listen(relay, resumeFrom);
  }
  log(`store ${storePubkey} listening on ${config.inboxRelays.join(', ')}`);

  let sweepQueued = false;
  const sweep = () => {
    // A slow sweep never piles up behind itself on the queue.
    if (sweepQueued) {
      return;
    }
    sweepQueued = true;
    // Every wrap received before now is already on the queue, ahead of this sweep.
    const allLive = listener.allLive(config.inboxRelays);
    const queuedAt = nowSecs();
    enqueue(async () => {
      sweepQueued = false;
      await runtime.sweep(allLive, queuedAt);
    });
  };
  sweep();
  setInterval(sweep, CATCH_UP_INTERVAL_MS);
  if (target !== undefined) {
    startWebhooks(state, store, target, home, enqueue);
  }
}

/**
 * Send the webhooks due, every `WEBHOOK_TICK_MS`. Each pick runs on the queue,
 * between tasks, so it only sees entries already saved; the requests run off
 * it, and each outcome is queued back and saved.
 */
function startWebhooks(
  state: LedgerState,
  store: { storePubkey: string },
  target: WebhookTarget,
  home: MerchantHome,
  enqueue: (task: () => Promise<void>) => void,
): void {
  const sender = new WebhookSender({
    state,
    store,
    target,
    commit: (change) => {
      enqueue(async () => {
        change();
        saveLedger(home.ledger, state);
      });
    },
    log,
    now: nowSecs,
    userAgent: USER_AGENT,
  });
  // Like the sweep: a busy queue holds one pick, never a pile of them.
  let tickQueued = false;
  const tick = () => {
    if (tickQueued) {
      return;
    }
    tickQueued = true;
    enqueue(async () => {
      tickQueued = false;
      void sender.tick();
    });
  };
  tick();
  setInterval(tick, WEBHOOK_TICK_MS);
  log(`webhook to ${new URL(target.url).origin} (order.paid)`);
}

function listOrders(home: MerchantHome): void {
  const state = openLedger(home.ledger);
  for (const line of orderLines(state, loadKeys(home).storePubkey)) {
    console.log(line);
  }
}

/** The configured webhook and its secret, for a `webhook` command. */
function commandTarget(config: MerchantConfig): WebhookTarget {
  if (config.webhook === undefined) {
    throw new Error('config.json has no webhook: add "webhook": { "url": "https://..." }');
  }
  const { target } = webhookTarget(config.webhook, readWebhookSecret());
  if (target === undefined) {
    throw new Error(`no webhook secret: ${WEBHOOK_SECRET_HINT}`);
  }
  return target;
}

/** `webhook test`: one signed `test` event; it fails unless the receiver answers 2xx. */
async function webhookTest(home: MerchantHome): Promise<void> {
  const target = commandTarget(loadConfig(home.config));
  const { body, eventId } = testBody(loadKeys(home).storePubkey);
  const result = await sendWebhook(
    target,
    { name: 'test', eventId, body },
    { now: nowSecs, userAgent: USER_AGENT },
  );
  if (!result.ok) {
    throw new Error(`the receiver did not take the test event: ${result.error}`);
  }
  console.log(`webhook test event ${eventId} taken (${result.status})`);
}

/**
 * `webhook retry` / `resend`: make the order's entry pending with a fresh
 * deadline and send it once now. The node must be stopped (the lock): a running
 * node rewrites the ledger from memory. The entry is saved before the send, so
 * a failed send stays pending for the next run.
 */
async function webhookAgain(home: MerchantHome, kind: RearmKind, key: string): Promise<void> {
  const config = loadConfig(home.config);
  const target = commandTarget(config);
  const storePubkey = loadKeys(home).storePubkey;
  takeLock(home);
  const state = openLedger(home.ledger);
  const plan = rearmWebhook(state, key, kind, storePubkey, nowSecs());
  if (!plan.ok) {
    throw new Error(plan.problem);
  }
  saveLedger(home.ledger, state);
  if (plan.order.customerRef !== undefined) {
    console.log(`ref     ${printable(plan.order.customerRef)}`);
  }
  const result = await sendWebhook(
    target,
    {
      name: 'order.paid',
      eventId: plan.entry.eventId,
      body: orderPaidBody(plan.order, plan.entry, { storePubkey }),
    },
    { now: nowSecs, userAgent: USER_AGENT },
  );
  applySendResult(plan.entry, result, nowSecs(), Math.random());
  saveLedger(home.ledger, state);
  console.log(`webhook ${plan.entry.eventId} for ${key}: ${outcomeText(plan.entry, result)}`);
  if (!result.ok) {
    throw new Error('not taken: the node sends it again when it runs, or run this again');
  }
}

async function webhookCommand(home: MerchantHome, args: Args): Promise<void> {
  if (args.subcommand === 'test') {
    await webhookTest(home);
    return;
  }
  if (args.subcommand === 'retry' || args.subcommand === 'resend') {
    if (args.target === undefined) {
      throw new Error(`webhook ${args.subcommand} needs the order: <buyer>:<orderId> (see orders)`);
    }
    await webhookAgain(home, args.subcommand, args.target);
    return;
  }
  throw new Error('webhook takes test, retry <buyer>:<orderId> or resend <buyer>:<orderId>');
}

async function check(home: MerchantHome): Promise<void> {
  const { config, products } = loadStore(home);
  const state = openLedger(home.ledger);
  refuseLostHistory(state, products);
  const loaded = loadKeys(home);
  // The relay probe is signed and AUTHed by the store key; nostr.json is written
  // only for an owner key that opens here.
  const { storeSecretKey, writeNostrJson } = openCheckKeys(loaded, readPassphrase());
  if (heldByRunningMerchant(home)) {
    console.log('note    a merchant is running on this home');
  }
  const pool = new SimplePool();
  try {
    const failing = await reportInboxRelays(pool, config, storeSecretKey);
    let offers: unknown;
    let views: RelayView[] = [];
    try {
      views = await refuseOffersNotHonoured(pool, config, loaded, state, products);
    } catch (error) {
      offers = error;
    }
    // Read into memory only: check writes no ledger.
    const feeRead = await treasuryReader(config).refresh(state, nowSecs());
    if (feeRead.kind === 'read') {
      console.log(`fee     the protocol fee is ${feeRead.feeBps} bps`);
    } else {
      console.log(`fee     ${feeRead.problem}`);
    }
    warnProfile(views, feeRead);
    await reportDomain(
      home,
      config,
      storeNostrJson(config, loaded.storePubkey, loaded.ownerPubkey),
      writeNostrJson,
    );
    if (offers !== undefined) {
      throw offers;
    }
    if (feeRead.kind === 'wrong_cluster') {
      throw new Error(feeRead.problem);
    }
    if (failing.length > 0) {
      throw new Error(
        `these inbox relays do not take and serve gift wraps for any key: ${failing.join(', ')}`,
      );
    }
  } finally {
    pool.destroy();
  }
}

/** Ask on a terminal; without one, refuse rather than wait or assume. */
async function confirmed(question: string, yes: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    throw new Error('no terminal to confirm on: pass --yes to answer without asking');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}

/**
 * Answer an order by hand. The node must be stopped (the lock): a running node
 * rewrites the ledger from memory. The close is saved first, then the answer
 * published to the store's inbox relays; below the two-relay threshold the
 * command fails, and a rerun sends the same answer again.
 */
async function answerByHand(home: MerchantHome, args: Args): Promise<void> {
  const key = args.target;
  if (key === undefined) {
    throw new Error(`${args.command ?? ''} needs the order: <buyer>:<orderId> (see orders)`);
  }
  const config = loadConfig(home.config);
  const storeSecretKey = openSecret(loadKeys(home), 'store', readPassphrase());
  takeLock(home);
  const state = openLedger(home.ledger);
  let request: HandRequest;
  if (args.command === 'complete') {
    request = { kind: 'delivered' };
  } else {
    request = {
      kind: 'refunded',
      tx: args.tx ?? '',
      amount: args.amount ?? '',
      ...(args.asset === undefined ? {} : { asset: args.asset }),
      payoutAssets: config.payouts.map((payout) => payout.caip19),
    };
  }
  const plan = planHandAnswer(state, key, request);
  if (!plan.ok) {
    throw new Error(plan.problem);
  }
  const order = state.orders[key];
  const held = order ?? plan.answer;
  console.log(`order    ${key}${order === undefined ? ' (closed)' : ''}`);
  console.log(`reported ${held.reportedTxs.join(', ') || '-'}`);
  console.log(`refused  ${(held.refusedTxs ?? []).join(', ') || '-'}`);
  console.log(`no leg   ${(held.noLegTxs ?? []).join(', ') || '-'}`);
  // Payments of at least the floor whose rest reached no known elisym treasury (paid rule 3).
  const unresolved =
    order === undefined
      ? state.unresolvedPayments.filter((entry) => entry.key === key).map((entry) => entry.tx)
      : Object.keys(order.feeUnresolved ?? {});
  if (unresolved.length > 0) {
    console.log(`fee      unresolved: ${unresolved.join(', ')} (the owner decides on these)`);
  }
  if (plan.answer.customerRef !== undefined) {
    console.log(
      `ref      ${printable(plan.answer.customerRef)} (a hand answer sends no webhook: credit it by hand)`,
    );
  }
  if (order?.blockedTx !== undefined) {
    console.log(`blocked  ${order.blockedTx}`);
  }
  if (plan.warning !== undefined) {
    console.log(`warning  ${plan.warning}`);
  }
  const what =
    plan.answer.kind === 'delivered'
      ? 'send "completed"'
      : `report a refund of ${plan.answer.amount ?? ''}${plan.answer.caip19 === undefined ? '' : ` ${plan.answer.caip19}`} in ${plan.answer.tx ?? ''}`;
  if (
    !(await confirmed(`${plan.rerun ? 'Send again' : 'Close the order and'} ${what}?`, args.yes))
  ) {
    throw new Error('not confirmed: nothing was sent');
  }
  if (!plan.rerun) {
    applyHandAnswer(state, key, plan.answer);
    saveLedger(home.ledger, state);
  }
  const pool = new SimplePool();
  try {
    const wrap = buildHandAnswer(plan, storeSecretKey, nowSecs());
    const sent = await publishHandAnswer(
      pool,
      config.inboxRelays,
      wrap,
      storeAuth(storeSecretKey),
      log,
    );
    const outcome = handOutcome(sent, config.inboxRelays.length);
    for (const line of outcome.lines) {
      console.log(line);
    }
    if (!outcome.done) {
      throw new Error('too few inbox relays took it: run the same command again to send it again');
    }
  } finally {
    pool.destroy();
  }
}

/** `encrypt-keys`: seal the home's plain keys with the passphrase, in place. */
function encryptKeys(home: MerchantHome, ownerOnly: boolean): void {
  const passphrase = readPassphrase();
  if (passphrase === undefined) {
    throw new Error(`encrypt-keys needs the passphrase: ${PASSPHRASE_HINT}`);
  }
  const { changed } = encryptHomeKeys(home, passphrase, ownerOnly);
  if (!changed) {
    console.log('keys    already encrypted: nothing to do');
    return;
  }
  console.log(`keys    encrypted (${ownerOnly ? 'the owner key only' : 'both keys'})`);
  for (const note of encryptionNotes(ownerOnly)) {
    console.log(`note    ${note}`);
  }
  console.log('note    older backups and snapshots of this home still hold the plain keys');
}

/**
 * `store-key`: the store's secret key, to paste into the admin page on this
 * machine. Only to a terminal, or with --yes: it must not land in a log
 * unasked. Never the owner key.
 */
function printStoreKey(home: MerchantHome, yes: boolean): void {
  const nsec = storeKeyForAdmin(
    loadKeys(home),
    readPassphrase(),
    process.stdout.isTTY === true,
    yes,
  );
  console.error(STORE_KEY_WARNING);
  console.log(nsec);
}

/**
 * `admin`: serve the admin page on this machine. It reads no home: the store
 * key is pasted into the page, which reads the relays itself.
 */
async function serveAdmin(portFlag: string | undefined): Promise<void> {
  const port = portFlag === undefined ? DEFAULT_ADMIN_PORT : Number(portFlag);
  if ((portFlag !== undefined && !/^\d{1,5}$/.test(portFlag)) || !isAdminPort(port)) {
    throw new Error('--port is a number from 1 to 65535');
  }
  const root = fileURLToPath(new URL('./admin/', import.meta.url));
  await startAdminServer(root, port);
  console.log(`admin   http://${ADMIN_HOST}:${port}/ (this machine only; Ctrl-C to stop)`);
  console.log(`note    get the key to paste with: elisym-merchant store-key`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.port !== undefined && args.command !== 'admin') {
    throw new Error('--port is for admin');
  }
  if (args.network !== undefined && args.command !== 'init') {
    throw new Error('--network is for init; the config names the network');
  }
  if (args.ownerOnly && args.command !== 'init' && args.command !== 'encrypt-keys') {
    throw new Error('--owner-only is for init and encrypt-keys');
  }
  const home = merchantHome(args.home);
  switch (args.command) {
    case 'init':
      init(home, args.network, args.ownerOnly);
      return;
    case 'encrypt-keys':
      encryptKeys(home, args.ownerOnly);
      process.exit(0);
      return;
    case 'store-key':
      printStoreKey(home, args.yes);
      return;
    case 'admin':
      stopOnSignals();
      await serveAdmin(args.port);
      return;
    case 'setup': {
      const stopRequested = deferSignals();
      let failed = false;
      try {
        await setup(home);
      } catch (error) {
        console.error(`error: ${errorText(error)}`);
        failed = true;
      }
      process.exit(stopRequested() ?? (failed ? 1 : 0));
      return;
    }
    case 'run':
      stopOnSignals();
      await run(home);
      return;
    case 'orders':
      listOrders(home);
      return;
    case 'check':
      await check(home);
      process.exit(0);
      return;
    case 'complete':
    case 'refund':
      await answerByHand(home, args);
      process.exit(0);
      return;
    case 'webhook':
      await webhookCommand(home, args);
      process.exit(0);
      return;
    default:
      console.log(USAGE);
      process.exit(args.command === undefined || args.command === 'help' ? 0 : 1);
  }
}

try {
  await main();
} catch (error) {
  console.error(`error: ${errorText(error)}`);
  process.exit(1);
}
