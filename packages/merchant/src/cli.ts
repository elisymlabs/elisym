#!/usr/bin/env bun
/**
 * The test merchant: `setup` publishes the store, `run` takes orders, verifies
 * payments by the direct-mode contract and delivers. State lives in
 * `.merchant/` (gitignored): `config.json` (written by hand), `keys.json`
 * (generated) and `ledger.json`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_PAYTO, KIND_PRODUCT } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import { createSolanaRpc } from '@solana/kit';
import { SimplePool } from 'nostr-tools/pool';
import {
  type EventTemplate,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import {
  CATCH_UP_INTERVAL_MS,
  OFFER_RELAYS,
  SOLANA_MEDIUMS,
  TERMS_CLOCK_MARGIN_SECS,
} from './constants';
import { storeIdentity } from './intake';
import { type MerchantOrder, loadLedger, saveLedger } from './ledger';
import { InboxListener } from './listener';
import { publishToRelays } from './publish';
import { type Delivery, buildDeliveryReply } from './reply';
import { MerchantRuntime } from './runtime';
import { type StoreConfig, type StoreKeys, buildStoreEvents } from './store-events';
import { publishTerms, retireTerms } from './terms';

interface MerchantConfig extends StoreConfig {
  network: Network;
  /** A Solana RPC for the network, server-side (a browser-restricted key will not do). */
  rpcUrl: string;
  delivery: Delivery;
}

// Next to the package, where its .gitignore keeps the store's secret keys out of git,
// wherever the command is run from.
const HOME = fileURLToPath(new URL('../.merchant', import.meta.url));
const CONFIG_PATH = join(HOME, 'config.json');
const KEYS_PATH = join(HOME, 'keys.json');
const LEDGER_PATH = join(HOME, 'ledger.json');
/** Held by a running merchant: `setup` must not write the ledger under it. */
const LOCK_PATH = join(HOME, 'run.lock');

/** Whether a process exists: EPERM means it does, owned by another user. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Whether a running merchant holds the ledger (a lock left by a dead process does not count). */
function heldByRunningMerchant(): boolean {
  let text: string;
  try {
    text = readFileSync(LOCK_PATH, 'utf8');
  } catch {
    return false;
  }
  const pid = Number(text);
  // An empty or garbled lock (a crash between creating and writing it) names no process.
  if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
    return true;
  }
  // Remove the stale lock only if it still holds what was judged: another
  // process may have taken it meanwhile.
  try {
    if (readFileSync(LOCK_PATH, 'utf8') === text) {
      rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    // Already gone.
  }
  return false;
}

/** Take the lock for this process, released on exit. */
function takeLock(): void {
  if (heldByRunningMerchant()) {
    throw new Error(`another merchant is running (${LOCK_PATH})`);
  }
  mkdirSync(HOME, { recursive: true });
  writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  const release = () => rmSync(LOCK_PATH, { force: true });
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}

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

function loadConfig(): MerchantConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as MerchantConfig;
}

function loadOrCreateKeys(create: boolean): StoreKeys {
  let text: string | undefined;
  try {
    text = readFileSync(KEYS_PATH, 'utf8');
  } catch (error) {
    // Only a missing file mints keys: an unreadable one must never replace the store's identity.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  if (text !== undefined) {
    const stored = JSON.parse(text) as { store: string; owner: string };
    return { storeSecretKey: hexToBytes(stored.store), ownerSecretKey: hexToBytes(stored.owner) };
  }
  if (!create) {
    throw new Error('no store keys: run setup first');
  }
  const keys = { storeSecretKey: generateSecretKey(), ownerSecretKey: generateSecretKey() };
  mkdirSync(HOME, { recursive: true });
  writeFileSync(
    KEYS_PATH,
    `${JSON.stringify({ store: bytesToHex(keys.storeSecretKey), owner: bytesToHex(keys.ownerSecretKey) })}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return keys;
}

async function setup(): Promise<void> {
  // A running merchant rewrites the whole ledger from memory: new terms written
  // under it would be lost, and the old price or payout would stay payable. The
  // lock is held for the whole setup, so a merchant cannot start in between.
  takeLock();
  const config = loadConfig();
  const keys = loadOrCreateKeys(true);
  const now = nowSecs();
  const state = loadLedger(LEDGER_PATH);
  const payouts = JSON.stringify(config.payouts);
  // An unchanged payout list keeps its first date: a new one would restart the buyers' cool-down.
  const paytoCreatedAt = state.payto?.payouts === payouts ? state.payto.createdAt : now;
  const built = buildStoreEvents(config, keys, now, {
    hints: config.inboxRelays.slice(0, 2),
    paytoCreatedAt,
  });
  const pool = new SimplePool();
  const relays = [...new Set([...OFFER_RELAYS, ...config.inboxRelays])];
  const acceptedKinds = new Set<number>();
  for (const event of built.events) {
    const accepted = await publishToRelays(pool, relays, event, storeAuth(keys), log);
    log(`kind ${event.kind}: accepted by ${accepted.length}/${relays.length}`);
    if (accepted.length > 0) {
      acceptedKinds.add(event.kind);
    }
  }
  pool.destroy();
  // The ledger follows what buyers can read: terms count only once the listing and the
  // payout list are on some relay.
  if (!acceptedKinds.has(KIND_PRODUCT) || !acceptedKinds.has(KIND_PAYTO)) {
    log('the listing or the payout list reached no relay: the ledger is left as it was');
    return;
  }
  state.terms = retireTerms(
    state.terms,
    built.terms.map((terms) => terms.caip19),
    now - TERMS_CLOCK_MARGIN_SECS,
  );
  // Dated a little before now: a local clock running ahead of chain time must not
  // refuse a payment made right after the change.
  for (const terms of built.terms) {
    state.terms = publishTerms(state.terms, terms, now - TERMS_CLOCK_MARGIN_SECS);
  }
  state.payto = { createdAt: paytoCreatedAt, payouts };
  // Orders can come from the moment the store is published: a later first run
  // reads back from here, not from its own start.
  state.resumeAt ??= now;
  saveLedger(LEDGER_PATH, state);
  console.log(`store   ${getPublicKey(keys.storeSecretKey)}`);
  console.log(`owner   ${getPublicKey(keys.ownerSecretKey)}`);
  console.log(`naddr   ${built.naddr}`);
  console.log(`nostr.json (level A only, served with CORS): ${JSON.stringify(built.nostrJson)}`);
}

/** Publish the delivery of a paid order; true when a relay took it. */
async function deliver(
  pool: SimplePool,
  order: MerchantOrder,
  config: MerchantConfig,
  keys: StoreKeys,
): Promise<boolean> {
  const reply = buildDeliveryReply(order, config.delivery, keys.storeSecretKey, nowSecs());
  // By convention the store replies on its OWN inbox relays: the buyer key has none.
  const accepted = await publishToRelays(
    pool,
    config.inboxRelays,
    reply.recipientWrap,
    storeAuth(keys),
    log,
  );
  return accepted.length > 0;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const keys = loadOrCreateKeys(false);
  const storePubkey = getPublicKey(keys.storeSecretKey);
  takeLock();
  const state = loadLedger(LEDGER_PATH);
  // Pings find a half-open socket, which would otherwise never close.
  const pool = new SimplePool({ enablePing: true });
  const runtime = new MerchantRuntime({
    state,
    store: storeIdentity(storePubkey, config.product.d, [SOLANA_MEDIUMS[config.network]]),
    storeSecretKey: keys.storeSecretKey,
    context: { rpc: createSolanaRpc(config.rpcUrl), network: config.network },
    save: () => saveLedger(LEDGER_PATH, state),
    deliver: (order) => deliver(pool, order, config, keys),
    log,
    now: nowSecs,
  });
  const startedAt = nowSecs();

  // One queue: every ledger change happens in order, and is saved before anything is sent.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      log(`error: ${errorText(error)}`);
    });
  };

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
  saveLedger(LEDGER_PATH, state);
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

const command = process.argv[2];
if (command === 'setup') {
  await setup();
} else if (command === 'run') {
  await run();
} else {
  console.log(`usage: bun src/cli.ts setup|run

  setup  publish the store (edit .merchant/config.json first; see config.example.json)
  run    take orders, verify payments, deliver

Check by hand that each inbox relay keeps kind 1059 gift wraps for at least two
days past their date (NIP-59 back-dates them up to two days, and a merchant that
was down reads them back from there), and that at least one accepts gift wraps
for any recipient: the store replies there, the buyer key has no inbox of its own.`);
  process.exit(1);
}
