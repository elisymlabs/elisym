/**
 * elisym merchant node. `init` makes the home (config template and keys),
 * `setup` checks the inbox relays and publishes the store, `run` takes orders,
 * verifies payments by the direct-mode contract and delivers.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { KIND_INBOX_RELAYS, KIND_PAYTO, KIND_PRODUCT, splitNip05 } from '@elisym/commerce';
import { createSolanaRpc } from '@solana/kit';
import { SimplePool } from 'nostr-tools/pool';
import { type EventTemplate, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  checkDomain,
  checkInboxRelays,
  newestInboxList,
  newestListing,
  newestPayoutList,
  offerProblems,
} from './checks';
import { type MerchantConfig, configTemplate, loadConfig } from './config';
import {
  CATCH_UP_INTERVAL_MS,
  OFFER_RELAYS,
  SOLANA_MEDIUMS,
  TERMS_CLOCK_MARGIN_SECS,
} from './constants';
import {
  type MerchantHome,
  ensureHome,
  heldByRunningMerchant,
  loadOrCreateKeys,
  merchantHome,
  takeLock,
} from './home';
import { storeIdentity } from './intake';
import { type LedgerState, type MerchantOrder, loadLedger, saveLedger } from './ledger';
import { InboxListener } from './listener';
import { publishToRelays } from './publish';
import { buildDeliveryReply } from './reply';
import { MerchantRuntime } from './runtime';
import { payoutListDate, recordPublished, setupRefusal } from './setup-ledger';
import { type StoreKeys, buildStoreEvents } from './store-events';
import { standingTerms } from './terms';

const USAGE = `usage: elisym-merchant <command> [--home <dir>]

  init [--network devnet|mainnet]
         make the home: a config.json to edit and the store's keys
  setup  check the inbox relays and publish the store (after editing config.json)
  run    take orders, verify payments, deliver
  orders list the orders: paid, delivered, the buyer's email
  check  check the inbox relays, the owner's payout list and the domain

The home is --home, else $ELISYM_MERCHANT_HOME, else ~/.elisym-merchant.
It holds the store's secret keys: keep it private and back it up.`;

/** Answers a relay's NIP-42 challenge with the store key. */
function storeAuth(keys: StoreKeys) {
  return async (template: EventTemplate) => finalizeEvent(template, keys.storeSecretKey);
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
  home: string | undefined;
  network: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: undefined, home: undefined, network: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--home' || arg === '--network') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      args[arg === '--home' ? 'home' : 'network'] = value;
      index += 1;
    } else if (args.command === undefined && arg !== undefined && !arg.startsWith('--')) {
      args.command = arg;
    } else {
      throw new Error(`unknown argument ${arg ?? ''}`);
    }
  }
  return args;
}

function init(home: MerchantHome, network: string | undefined): void {
  if (network !== undefined && network !== 'devnet' && network !== 'mainnet') {
    throw new Error('--network is devnet or mainnet');
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
  const keys = loadOrCreateKeys(home, true);
  console.log(`store   ${getPublicKey(keys.storeSecretKey)}`);
  console.log(`owner   ${getPublicKey(keys.ownerSecretKey)}`);
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
  keys: StoreKeys,
): Promise<string[]> {
  const reader = new SimplePool();
  let verdicts: Awaited<ReturnType<typeof checkInboxRelays>>;
  try {
    verdicts = await checkInboxRelays(
      pool,
      reader,
      config.inboxRelays,
      keys.storeSecretKey,
      storeAuth(keys),
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
  writeFileSync(home.nostrJson, `${JSON.stringify(nostrJson)}\n`);
  console.log(
    `nostr   serve ${home.nostrJson} at https://${split.domain}/.well-known/nostr.json with "Access-Control-Allow-Origin: *"`,
  );
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
  const keys = loadOrCreateKeys(home, false);
  const state = loadLedger(home.ledger);
  const refusal = setupRefusal(state, config.product.d);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  const pool = new SimplePool();
  try {
    const failing = await reportInboxRelays(pool, config, keys);
    if (failing.length > 0) {
      throw new Error(
        `these inbox relays do not take and serve gift wraps for any key: ${failing.join(', ')}. Replace them in config.json.`,
      );
    }
    const relays = [...new Set([...OFFER_RELAYS, ...config.inboxRelays])];
    const now = nowSecs();
    const payouts = JSON.stringify(config.payouts);
    const newest = await newestPayoutList(pool, relays, getPublicKey(keys.ownerSecretKey));
    const paytoCreatedAt = payoutListDate(state, payouts, newest?.created_at, now);
    const built = buildStoreEvents(config, keys, now, {
      hints: config.inboxRelays.slice(0, 2),
      paytoCreatedAt,
    });
    const acceptedKinds = new Set<number>();
    // Kinds a default relay took: every page reads those, whatever its naddr's hints.
    const everywhereKinds = new Set<number>();
    for (const event of built.events) {
      const accepted = await publishToRelays(pool, relays, event, storeAuth(keys), log);
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
    console.log(`store   ${getPublicKey(keys.storeSecretKey)}`);
    console.log(`owner   ${getPublicKey(keys.ownerSecretKey)}`);
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
  keys: StoreKeys,
  state: LedgerState,
): Promise<void> {
  const storePubkey = getPublicKey(keys.storeSecretKey);
  // Judged twice: from the default relays, which every page reads, and with the
  // store's own inbox relays too, which a page reads when its naddr hints them.
  const views = [OFFER_RELAYS, [...new Set([...OFFER_RELAYS, ...config.inboxRelays])]];
  const read = await Promise.all(
    views.map(async (relays) => {
      const [listing, payoutList, inboxList] = await Promise.all([
        newestListing(pool, relays, storePubkey, config.product.d),
        newestPayoutList(pool, relays, getPublicKey(keys.ownerSecretKey)),
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

/** Publish the delivery of a paid order to the inbox relays not in `skip`; the ones that took it. */
async function deliver(
  pool: SimplePool,
  order: MerchantOrder,
  skip: readonly string[],
  config: MerchantConfig,
  keys: StoreKeys,
): Promise<string[]> {
  const reply = buildDeliveryReply(order, config.product.delivery, keys.storeSecretKey, nowSecs());
  // By convention the store replies on its OWN inbox relays: the buyer key has none.
  return await publishToRelays(
    pool,
    config.inboxRelays.filter((relay) => !skip.includes(relay)),
    reply.recipientWrap,
    storeAuth(keys),
    log,
  );
}

async function run(home: MerchantHome): Promise<void> {
  const config = loadConfig(home.config);
  const keys = loadOrCreateKeys(home, false);
  const storePubkey = getPublicKey(keys.storeSecretKey);
  takeLock(home);
  // Pings find a half-open socket, which would otherwise never close.
  const pool = new SimplePool({ enablePing: true });
  const state = loadLedger(home.ledger);
  await refuseOffersNotHonoured(pool, config, keys, state);

  // One queue: every ledger change happens in order, and is saved before anything is sent.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      log(`error: ${errorText(error)}`);
    });
  };

  const runtime = new MerchantRuntime({
    state,
    store: storeIdentity(storePubkey, config.product.d, [SOLANA_MEDIUMS[config.network]]),
    storeSecretKey: keys.storeSecretKey,
    context: { rpc: createSolanaRpc(config.rpcUrl), network: config.network },
    save: () => saveLedger(home.ledger, state),
    deliver: (order, skip) => deliver(pool, order, skip, config, keys),
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
    auth: storeAuth(keys),
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
    const email = order.email === undefined ? '' : ` email=${order.email}`;
    console.log(`${when} ${orderStatus(order)} ${order.key}${paid}${email}`);
  }
  console.log(`${all.length} order(s)`);
}

async function check(home: MerchantHome): Promise<void> {
  const config = loadConfig(home.config);
  const keys = loadOrCreateKeys(home, false);
  if (heldByRunningMerchant(home)) {
    console.log('note    a merchant is running on this home');
  }
  const pool = new SimplePool();
  try {
    const failing = await reportInboxRelays(pool, config, keys);
    let offers: unknown;
    try {
      await refuseOffersNotHonoured(pool, config, keys, loadLedger(home.ledger));
    } catch (error) {
      offers = error;
    }
    await reportDomain(home, config, buildStoreEvents(config, keys, nowSecs()).nostrJson);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.network !== undefined && args.command !== 'init') {
    throw new Error('--network is for init; the config names the network');
  }
  const home = merchantHome(args.home);
  switch (args.command) {
    case 'init':
      init(home, args.network);
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
