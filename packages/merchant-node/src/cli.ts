/**
 * elisym merchant node. `init` makes the home (config template and keys),
 * `setup` checks the inbox relays and publishes the store, `run` takes orders,
 * verifies payments by the direct-mode contract and delivers.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { KIND_INBOX_RELAYS, KIND_PAYTO, KIND_PRODUCT, splitNip05 } from '@elisym/commerce';
import { createSolanaRpc } from '@solana/kit';
import { SimplePool } from 'nostr-tools/pool';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { ADMIN_HOST, DEFAULT_ADMIN_PORT, isAdminPort, startAdminServer } from './admin-server';
import {
  checkDomain,
  checkInboxRelays,
  newestInboxList,
  newestListing,
  newestPayoutList,
  offerProblems,
} from './checks';
import { type MerchantConfig, configTemplate, loadConfig, tempoRegistryNetwork } from './config';
import {
  CATCH_UP_INTERVAL_MS,
  OFFER_RELAYS,
  SOLANA_MEDIUMS,
  TERMS_CLOCK_MARGIN_SECS,
} from './constants';
import { deliverOrder, publishSelfCopy } from './deliver';
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
import { type LedgerState, type MerchantOrder, loadLedger, saveLedger } from './ledger';
import { InboxListener } from './listener';
import { printable } from './printable';
import { publishToRelays } from './publish';
import { MerchantRuntime } from './runtime';
import { SelfCopies } from './self-copies';
import { payoutListDate, recordPublished, setupRefusal } from './setup-ledger';
import { buildStoreEvents, storeNostrJson } from './store-events';
import { tempoContextFor } from './tempo';
import { standingTerms } from './terms';

const USAGE = `usage: elisym-merchant <command> [--home <dir>]

  init [--network devnet|mainnet]
         make the home: a config.json to edit and the store's keys
  setup  check the inbox relays and publish the store (after editing config.json)
  run    take orders, verify payments, deliver
  orders list the orders: paid, delivered, the buyer's email
  check  check the inbox relays, the owner's payout list and the domain
  encrypt-keys [--owner-only]
         encrypt the keys in keys.json with $ELISYM_MERCHANT_PASSPHRASE
         (or the file $ELISYM_MERCHANT_PASSPHRASE_FILE names); both keys by default
  store-key [--yes]
         print the store's secret key, for the admin page on this machine
  admin [--port <port>]
         serve the admin page on 127.0.0.1 (default port ${DEFAULT_ADMIN_PORT}): paste the
         store key there to see the orders your inbox relays hold
  deliver <buyer>:<orderId> [--yes]
         answer an unpaid order by hand with the configured delivery
  refund <buyer>:<orderId> --tx <refund tx> --amount <subunits> [--asset <caip19>] [--yes]
         answer an unpaid order by hand with a refund you already sent
         (--asset: the refunded coin; required when the store has several payouts,
         and ignored, with a warning, when re-sending an answer kept without one)
         (both need the node stopped; --yes skips the confirmation)

The home is --home, else $ELISYM_MERCHANT_HOME, else ~/.elisym-merchant.
It holds the store's secret keys: keep it private and back it up. init encrypts
new keys when $ELISYM_MERCHANT_PASSPHRASE (or ..._FILE) is set (--owner-only:
the owner key only); a command that needs an encrypted key reads it from there.`;

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

interface Args {
  command: string | undefined;
  /** The order key of `deliver` / `refund`. */
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

function isValueFlag(arg: string): arg is keyof typeof VALUE_FLAGS {
  return arg in VALUE_FLAGS;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: undefined,
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
      (args.command === 'deliver' || args.command === 'refund') &&
      args.target === undefined &&
      arg !== undefined &&
      !arg.startsWith('--')
    ) {
      args.target = arg;
    } else {
      throw new Error(`unknown argument ${arg ?? ''}`);
    }
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
  console.log('next    edit config.json, then run setup');
}

/**
 * Print what the inbox relays can do; the ones that do not take and serve gift
 * wraps for any key. Every one must: buyers send orders to all of them, and a
 * delivery one of them took counts toward the two a delivery wants.
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

async function setup(home: MerchantHome): Promise<void> {
  // A running merchant rewrites the whole ledger from memory: new terms written
  // under it would be lost, and the old price or payout would stay payable. The
  // lock is held for the whole setup, so a merchant cannot start in between.
  takeLock(home);
  const config = loadConfig(home.config);
  // Both secrets first, before anything is checked, signed or published: a
  // missing or wrong passphrase must never leave a half-published store.
  const loaded = loadKeys(home);
  const keys = openSetupKeys(loaded, readPassphrase());
  const state = loadLedger(home.ledger);
  const refusal = setupRefusal(state, config.product.d);
  if (refusal !== undefined) {
    throw new Error(refusal);
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
    const now = nowSecs();
    const payouts = JSON.stringify(config.payouts);
    const newest = await newestPayoutList(pool, relays, loaded.ownerPubkey);
    const paytoCreatedAt = payoutListDate(state, payouts, newest?.created_at, now);
    const built = buildStoreEvents(config, keys, now, {
      hints: config.inboxRelays.slice(0, 2),
      paytoCreatedAt,
    });
    const acceptedKinds = new Set<number>();
    // Kinds a default relay took: every page reads those, whatever its naddr's hints.
    const everywhereKinds = new Set<number>();
    for (const event of built.events) {
      const accepted = await publishToRelays(
        pool,
        relays,
        event,
        storeAuth(keys.storeSecretKey),
        log,
      );
      log(`kind ${event.kind}: accepted by ${accepted.length}/${relays.length}`);
      if (accepted.length > 0) {
        acceptedKinds.add(event.kind);
      }
      if (accepted.some((relay) => OFFER_RELAYS.includes(relay))) {
        everywhereKinds.add(event.kind);
      }
    }
    const outcome = {
      listing: acceptedKinds.has(KIND_PRODUCT),
      payouts: acceptedKinds.has(KIND_PAYTO),
    };
    if (!outcome.listing && !outcome.payouts) {
      throw new Error(
        'neither the listing nor the payout list reached a relay: the ledger is left as it was',
      );
    }
    // Dated a little before now: a local clock running ahead of chain time must not
    // refuse a payment made right after the change.
    recordPublished(
      state,
      built.terms,
      outcome,
      now - TERMS_CLOCK_MARGIN_SECS,
      { createdAt: paytoCreatedAt, payouts },
      config.product.d,
    );
    // Orders can come from the moment the store is published: a later first run
    // reads back from here, not from its own start.
    state.resumeAt ??= now;
    saveLedger(home.ledger, state);
    console.log(`store   ${loaded.storePubkey}`);
    console.log(`owner   ${loaded.ownerPubkey}`);
    console.log(`naddr   ${built.naddr}`);
    await reportDomain(home, config, built.nostrJson);
    // Buyers send orders to the inbox list: one that did not go out may leave them
    // writing to relays the node no longer reads.
    const missing = [
      [KIND_PRODUCT, 'the listing'],
      [KIND_PAYTO, 'the payout list'],
      [KIND_INBOX_RELAYS, 'the inbox list'],
    ]
      .filter(([kind]) => !everywhereKinds.has(kind as number))
      .map(([, name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(', ')} reached none of the default relays: buyers may see part of the change (the ledger follows what they see). Run setup again.`,
      );
    }
  } finally {
    pool.destroy();
  }
}

/**
 * Refuse to run when the relays offer buyers something this node does not
 * honour (see `offersNotHonoured`): a buyer could pay it and never get a delivery.
 */
async function refuseOffersNotHonoured(
  pool: SimplePool,
  config: MerchantConfig,
  pubkeys: { storePubkey: string; ownerPubkey: string },
  state: LedgerState,
): Promise<void> {
  const { storePubkey, ownerPubkey } = pubkeys;
  // Judged twice: from the default relays, which every page reads, and with the
  // store's own inbox relays too, which a page reads when its naddr hints them.
  const views = [OFFER_RELAYS, [...new Set([...OFFER_RELAYS, ...config.inboxRelays])]];
  const read = await Promise.all(
    views.map(async (relays) => {
      const [listing, payoutList, inboxList] = await Promise.all([
        newestListing(pool, relays, storePubkey, config.product.d),
        newestPayoutList(pool, relays, ownerPubkey),
        newestInboxList(pool, relays, storePubkey),
      ]);
      return { listing, payoutList, inboxList };
    }),
  );
  const { problems, served } = offerProblems(
    read,
    config.inboxRelays,
    config.network,
    standingTerms(state.terms),
    config.tempo === undefined ? undefined : tempoRegistryNetwork(config.tempo.network),
  );
  if (problems.length > 0) {
    throw new Error(
      `the relays offer buyers what this node does not honour: ${problems.join('; ')}. Run setup (it publishes what the config names and records it) before taking orders.`,
    );
  }
  if (!served) {
    log(
      'warning: no relay served the listing or the payout list; run setup if the store is not published',
    );
  }
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
  const config = loadConfig(home.config);
  const loaded = loadKeys(home);
  const storeSecretKey = openSecret(loaded, 'store', readPassphrase());
  const storePubkey = loaded.storePubkey;
  takeLock(home);
  // Pings find a half-open socket, which would otherwise never close.
  const pool = new SimplePool({ enablePing: true });
  const state = loadLedger(home.ledger);
  await refuseOffersNotHonoured(pool, config, loaded, state);

  // One queue: every ledger change happens in order, and is saved before anything is sent.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      log(`error: ${errorText(error)}`);
    });
  };

  const tempo = tempoContextFor(config, storePubkey);
  const mediums = [
    ...(config.rpcUrl === undefined ? [] : [SOLANA_MEDIUMS[config.network]]),
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
  const runtime = new MerchantRuntime({
    state,
    store: storeIdentity(storePubkey, config.product.d, mediums),
    storeSecretKey,
    // With no Solana payout the Solana catch-up has no terms to scan and reads nothing.
    context: {
      rpc: createSolanaRpc(config.rpcUrl ?? 'https://api.devnet.solana.com'),
      network: config.network,
    },
    ...(tempo === undefined ? {} : { tempo }),
    // No Solana payout configured: the Solana sweep reads nothing (no cluster to guess).
    ...(config.rpcUrl === undefined ? { catchUp: async () => ({ paid: [], incomplete: [] }) } : {}),
    save: () => saveLedger(home.ledger, state),
    deliver: (order, skip) =>
      deliverOrder(
        {
          pool,
          inboxRelays: config.inboxRelays,
          delivery: config.product.delivery,
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
}

function orderStatus(order: MerchantOrder): string {
  if (order.paid === undefined) {
    return 'open';
  }
  return order.deliveredAt === undefined ? 'paid, delivering' : 'delivered';
}

function listOrders(home: MerchantHome): void {
  const state = loadLedger(home.ledger);
  const all = Object.values(state.orders).sort((left, right) => left.createdAt - right.createdAt);
  for (const order of all) {
    const when = new Date(order.createdAt * 1000).toISOString();
    const paid = order.paid === undefined ? '' : ` ${order.paid.amount} ${order.paid.signature}`;
    const email = order.email === undefined ? '' : ` email=${printable(order.email)}`;
    console.log(`${when} ${orderStatus(order)} ${order.key}${paid}${email}`);
  }
  console.log(`${all.length} order(s)`);
  for (const [key, answer] of Object.entries(state.answeredByHand ?? {})) {
    const detail =
      answer.kind === 'delivered'
        ? (answer.delivery?.value ?? '')
        : `${answer.amount ?? ''} in ${answer.tx ?? ''}`;
    console.log(`answered by hand: ${key} ${answer.kind} ${detail}`);
  }
}

async function check(home: MerchantHome): Promise<void> {
  const config = loadConfig(home.config);
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
    try {
      await refuseOffersNotHonoured(pool, config, loaded, loadLedger(home.ledger));
    } catch (error) {
      offers = error;
    }
    await reportDomain(
      home,
      config,
      storeNostrJson(config, loaded.storePubkey, loaded.ownerPubkey),
      writeNostrJson,
    );
    if (offers !== undefined) {
      throw offers;
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
 * published to the store's inbox relays; below the delivery threshold the
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
  const state = loadLedger(home.ledger);
  const request: HandRequest =
    args.command === 'deliver'
      ? { kind: 'delivered', delivery: config.product.delivery }
      : {
          kind: 'refunded',
          tx: args.tx ?? '',
          amount: args.amount ?? '',
          ...(args.asset === undefined ? {} : { asset: args.asset }),
          payoutAssets: config.payouts.map((payout) => payout.caip19),
        };
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
  if (order?.blockedTx !== undefined) {
    console.log(`blocked  ${order.blockedTx}`);
  }
  if (plan.warning !== undefined) {
    console.log(`warning  ${plan.warning}`);
  }
  const what =
    plan.answer.kind === 'delivered'
      ? `deliver "${plan.answer.delivery?.value ?? ''}"`
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
    case 'deliver':
    case 'refund':
      await answerByHand(home, args);
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
