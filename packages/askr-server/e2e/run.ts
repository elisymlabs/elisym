/**
 * End to end (2.4, 4.4, 5.8, 7.3, 9): the marketplace relay config and
 * Postgres in Docker, a synthetic store activated through the operator CLI,
 * the gateway and a worker with a scripted model, a headless widget client,
 * and the lease, reservation and dedup races on real Postgres (PGlite in
 * `bun qa` is single-connection and proves nothing about them). Not part of
 * `bun qa` (CI has no Docker):
 *
 *   bun packages/askr-server/e2e/run.ts
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_WRAP_BACKDATE_SECS,
  type ChatMessage,
  unwrapChatMessage,
  wrapChatMessage,
} from '@elisym/askr';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { runCli } from '../src/cli';
import { type Db, STORES_CHANNEL } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { migrate } from '../src/db/migrations';
import { createPgDb } from '../src/db/pg';
import { createGateway } from '../src/gateway/gateway';
import { serveGateway } from '../src/gateway/http';
import { StoreEventPublisher } from '../src/publisher';
import { createServerPool } from '../src/relay/pool';
import { PgState } from '../src/state/pg-state';
import { StoreDirectory } from '../src/state/stores';
import type { Tier } from '../src/state/types';
import { isListed } from '../src/worker/catalog';
import { Worker } from '../src/worker/worker';
import {
  MASTER_KEY,
  ORIGIN,
  type SyntheticStore,
  scriptedProvider,
  syntheticStore,
} from '../tests/fixtures';

const RELAY = 'ws://localhost:7447';
const DATABASE_URL = 'postgres://askr:askr@localhost:55432/askr';
const TIER_ARGS = [
  '--messages',
  '50',
  '--daily',
  '5',
  '--monthly',
  '100',
  '--tickets',
  '100',
  '--products',
  '1000',
  '--sync-minutes',
  '60',
  '--branding',
  'true',
];
const GATEWAY_PORT = 8799;
const HERE = dirname(fileURLToPath(import.meta.url));

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  failures += ok ? 0 : 1;
}

async function waitForRelay(pool: SimplePool): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.ensureRelay(RELAY, { connectionTimeout: 1_000 });
      return;
    } catch {
      await sleep(1_000);
    }
  }
  throw new Error('relay did not come up');
}

/** What the database layer logged (connection losses), checked after the loss below. */
const DB_LOGS: string[] = [];

function logDb(message: string): void {
  DB_LOGS.push(message);
  console.error(message);
}

async function waitForDb(): Promise<Db> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const db = createPgDb(DATABASE_URL, logDb);
    try {
      await db.query('select 1');
      return db;
    } catch {
      await db.close();
      await sleep(1_000);
    }
  }
  throw new Error('postgres did not come up');
}

/** A pending store row with the synthetic store's keys, as onboarding leaves it (7.3). */
async function insertPending(db: Db, vault: KeyVault, store: SyntheticStore): Promise<void> {
  await db.query(
    `insert into stores (owner, status, assistant, assistant_key, catalog_key, catalog_key_secret, created_at)
     values ($1, 'pending', $2, $3, $4, $5, $6)`,
    [
      store.owner,
      store.assistant,
      vault.seal(store.assistantSecret, store.owner, 'assistant'),
      store.catalogKey,
      vault.seal(store.catalogSecret, store.owner, 'catalog'),
      nowSecs(),
    ],
  );
}

/** The lease, reservation and dedup races on real Postgres (5.8). */
async function races(db: Db, vault: KeyVault, directory: StoreDirectory): Promise<void> {
  const state = new PgState(db, vault);
  const tight: Tier = {
    name: 'tight',
    messagesPerSessionPerDay: 50,
    dailyBudgetUsd: '1',
    monthlyBudgetUsd: '100',
    ticketsPerStorePerMinute: 100,
    maxProducts: 10,
    syncIntervalMinutes: 60,
    branding: true,
  };
  await directory.setTier(tight);
  const store = syntheticStore(nowSecs());
  await insertPending(db, vault, store);
  await directory.setStatus(store.owner, 'active', 'tight');
  const now = nowSecs();

  const holders = Array.from({ length: 8 }, (_unused, index) => `racer-${index}`);
  const taken = await Promise.all(holders.map((holder) => state.acquireLeases(holder, now, 60)));
  const winners = taken.filter((leases) =>
    leases.some((lease) => lease.store.owner === store.owner),
  );
  check('eight holders racing for a free store: exactly one gets the lease', winners.length === 1);
  const epoch = winners[0]?.find((lease) => lease.store.owner === store.owner)?.epoch ?? 0;

  const sessions = await Promise.all(
    Array.from({ length: 30 }, () =>
      state.session(store.owner, store.assistant, getPublicKey(generateSecretKey()), now),
    ),
  );
  const admitted = await Promise.all(
    sessions.map((session) => state.admitAsk(session, 'c3'.repeat(16), '0.07', epoch, now)),
  );
  const totals = await state.dayTotals(store.owner, now);
  check(
    'thirty admissions at once reserve within the budget (14 of 30 at 0.07 of 1)',
    admitted.filter((result) => result.admitted).length === 14 && totals.reserved === '0.98',
  );

  const recorded = await Promise.all(
    Array.from({ length: 10 }, () => state.recordRumor('d4'.repeat(32), now)),
  );
  check(
    'a rumor id recorded ten times at once is taken once',
    recorded.filter(Boolean).length === 1,
  );

  const sessionPairs = await Promise.all(
    Array.from({ length: 10 }, () =>
      state.session(store.owner, store.assistant, 'e5'.repeat(32), now),
    ),
  );
  check(
    'ten session reads at once for a new visitor agree on one session',
    new Set(sessionPairs.map((session) => session.id)).size === 1,
  );

  await handoverRace(db, vault, state);
  await answerDropRace(db, vault, state);
}

const RACE_WRAP: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'e'.repeat(64),
  created_at: 0,
  kind: 1059,
  tags: [],
  content: '',
  sig: '0'.repeat(128),
};

/**
 * A turn answering or failing while its session is dropped (5.8): a first
 * message past the session's end replaces it, or the sweep ends it, at the
 * same moment. Repeated: no transaction fails (a deadlock is an error), and
 * every attempt is charged what its turn spent, once.
 */
async function answerDropRace(db: Db, vault: KeyVault, state: PgState): Promise<void> {
  const store = syntheticStore(nowSecs());
  await insertPending(db, vault, store);
  await db.query(`update stores set status = 'active', tier = 'tight' where owner = $1`, [
    store.owner,
  ]);
  const now = nowSecs();
  const [lease] = (await state.acquireLeases('instance-c', now, 600)).filter(
    (held) => held.store.owner === store.owner,
  );
  const epoch = lease?.epoch ?? 0;
  const rounds = 40;
  const spentPerTurn = '0.004';
  const errors: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const visitor = getPublicKey(generateSecretKey());
    const session = await state.session(store.owner, store.assistant, visitor, now);
    const askId = round.toString(16).padStart(32, '0');
    const admitted = await state.admitAsk(session, askId, '0.01', epoch, now);
    if (!admitted.admitted) {
      errors.push(`round ${round}: not admitted`);
      continue;
    }
    const { attemptId } = admitted.record;
    // Past the sweep below, so the sweep never charges the attempt in full itself.
    await state.startAsk(session, askId, attemptId, epoch, (session.sessionEnd + 600) * 1000);
    const answering = round % 2 === 0;
    const finish = answering
      ? state.answerAsk(
          { ...session, visitorMessages: ['hi'] },
          askId,
          attemptId,
          epoch,
          RACE_WRAP,
          spentPerTurn,
          now,
        )
      : state.failAsk(session, askId, attemptId, epoch, spentPerTurn);
    const drop =
      round % 4 < 2
        ? state.session(store.owner, store.assistant, visitor, session.sessionEnd)
        : state.sweep(session.sessionEnd);
    const [finished, dropped] = await Promise.allSettled([finish, drop]);
    for (const outcome of [finished, dropped]) {
      if (outcome.status === 'rejected') {
        errors.push(
          `round ${round}: ${outcome.reason instanceof Error ? outcome.reason.message : 'unknown'}`,
        );
      }
    }
    if (answering && finished.status === 'fulfilled' && !finished.value) {
      // What the worker does when its answer lost to the drop: settle what the turn spent.
      await state.failAsk(session, askId, attemptId, epoch, spentPerTurn);
    }
  }
  const totals = await state.dayTotals(store.owner, now);
  const [held] = await db.query<{ count: number }>(
    'select count(*)::int8 as count from reservations where owner = $1',
    [store.owner],
  );
  if (errors.length > 0) {
    console.error(errors.slice(0, 5).join('\n'));
  }
  check(
    'answers and failures racing session drops: no deadlock, each turn charged once',
    errors.length === 0 &&
      totals.spent === new Decimal(spentPerTurn).times(rounds).toString() &&
      totals.reserved === '0' &&
      held?.count === 0,
  );
}

/**
 * A lease handover (5.8): instance A still uses its old epoch while B holds
 * the new one, both admitting and retrying the same asks at once. A is never
 * admitted, each ask has one live attempt, and once the leases are gone the
 * sweep leaves no reservation held.
 */
async function handoverRace(db: Db, vault: KeyVault, state: PgState): Promise<void> {
  const store = syntheticStore(nowSecs());
  await insertPending(db, vault, store);
  // Activated without a notify, so the running e2e worker does not reach for it first.
  await db.query(`update stores set status = 'active', tier = 'tight' where owner = $1`, [
    store.owner,
  ]);
  const now = nowSecs();
  const epochOf = (leases: { store: { owner: string }; epoch: number }[]) =>
    leases.find((lease) => lease.store.owner === store.owner)?.epoch ?? 0;
  const stale = epochOf(await state.acquireLeases('instance-a', now, 60));
  await state.releaseLeases('instance-a');
  const current = epochOf(await state.acquireLeases('instance-b', now, 60));
  const askId = 'f6'.repeat(16);
  const sessions = await Promise.all(
    Array.from({ length: 20 }, () =>
      state.session(store.owner, store.assistant, getPublicKey(generateSecretKey()), now),
    ),
  );
  const admissions = await Promise.all(
    sessions.map((session) =>
      Promise.all([
        state.admitAsk(session, askId, '0.01', stale, now),
        state.admitAsk(session, askId, '0.01', current, now),
        state.admitAsk(session, askId, '0.01', current, now),
      ]),
    ),
  );
  check(
    'a stale epoch admits nothing and each ask is admitted once under the current one',
    stale !== current &&
      admissions.every(
        ([byStale, ...byCurrent]) =>
          byStale?.admitted === false &&
          byCurrent.filter((admission) => admission?.admitted).length === 1,
      ),
  );
  // Half the attempts run past their deadline (retryable), half are live.
  await Promise.all(
    sessions.map(async (session, index) => {
      const record = await state.askRecord(session, askId);
      if (record) {
        const deadline = index % 2 === 0 ? now * 1000 - 1 : (now + 120) * 1000;
        await state.startAsk(session, askId, record.attemptId, current, deadline);
      }
    }),
  );
  const retries = await Promise.all(
    sessions.map(async (session) => {
      const attemptId = (await state.askRecord(session, askId))?.attemptId ?? '';
      return Promise.all([
        state.retryAsk(session, askId, attemptId, '0.01', stale, now),
        state.retryAsk(session, askId, attemptId, '0.01', current, now),
        state.retryAsk(session, askId, attemptId, '0.01', current, now),
      ]);
    }),
  );
  check(
    'a stale epoch retries nothing; a run past its deadline is retried once, a live one never',
    retries.every(([byStale, ...byCurrent], index) => {
      const admitted = byCurrent.filter((retry) => retry?.admitted).length;
      return byStale?.admitted === false && admitted === (index % 2 === 0 ? 1 : 0);
    }),
  );
  await state.releaseLeases('instance-b');
  await state.sweep(now + 600);
  const [held] = await db.query<{ count: number }>(
    'select count(*)::int8 as count from reservations where owner = $1',
    [store.owner],
  );
  const totals = await state.dayTotals(store.owner, now);
  check(
    'after the handover race and a sweep no reservation is held',
    held?.count === 0 && totals.reserved === '0',
  );
}

/**
 * A Postgres connection loss (7.3, 9): every other backend is terminated, so
 * idle pool clients and the LISTEN connection error. The process survives,
 * LISTEN comes back on its own and hears a new notify.
 */
async function connectionLoss(db: Db): Promise<void> {
  let heard = 0;
  const stop = await db.listen('askr_probe', () => {
    heard += 1;
  });
  // Several pool connections are idle when the backends go (an unhandled idle error would end the process).
  await Promise.all(Array.from({ length: 5 }, () => db.query('select pg_sleep(0.05)')));
  await db.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`,
  );
  const back = await waitFor(() => (heard > 0 ? true : undefined), 15_000);
  const before = heard;
  await db.query(`select pg_notify('askr_probe', 'x')`);
  const notified = await waitFor(() => (heard > before ? true : undefined), 5_000);
  check(
    'after Postgres dropped every connection, LISTEN came back and hears a notify',
    back === true && notified === true,
  );
  check(
    'idle pool connections that Postgres dropped were handled and logged, not left unhandled',
    DB_LOGS.some((message) => message.startsWith('idle database connection lost')),
  );
  await stop();
}

async function publishAll(pool: SimplePool, events: readonly NostrEvent[]): Promise<boolean[]> {
  return Promise.all(
    events.map(async (event) => {
      try {
        await Promise.any(pool.publish([RELAY], event));
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** Collect the wraps to a visitor and open those authored by A. */
function inbox(pool: SimplePool, visitorSecret: Uint8Array, assistant: string) {
  const received: ChatMessage[] = [];
  const closer = pool.subscribe(
    [RELAY],
    { kinds: [1059], '#p': [getPublicKey(visitorSecret)] },
    {
      onevent: (event) => {
        const opened = unwrapChatMessage(event, visitorSecret);
        if (opened && opened.senderPubkey === assistant) {
          received.push(opened.message);
        }
      },
    },
  );
  return { received, close: () => closer.close() };
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  ms: number,
): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(200);
  }
  return undefined;
}

async function main(): Promise<void> {
  execFileSync('docker', ['compose', 'up', '-d', '--force-recreate'], {
    cwd: HERE,
    stdio: 'inherit',
  });
  const client = new SimplePool();
  await waitForRelay(client);

  const db = await waitForDb();
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await migrate(db);
  const vault = new KeyVault(MASTER_KEY);
  const directory = new StoreDirectory(db, vault);
  const state = new PgState(db, vault);

  // Onboarded and pending: O's config and authorization are stored, not published (7.3, K19).
  const store = syntheticStore(nowSecs());
  await insertPending(db, vault, store);
  const ownerSigned = store.events.filter((event) => event.pubkey === store.owner);
  await directory.addEvents(store.owner, ownerSigned);
  check(
    "the catalog key's listings and policy accepted by the relay",
    (
      await publishAll(
        client,
        store.events.filter((event) => event.pubkey !== store.owner),
      )
    ).every(Boolean),
  );
  const gatewaySecret = generateSecretKey();
  const provider = scriptedProvider(['The Wool jacket is a warm pick.']);
  let worker: Worker | undefined;
  const pool = createServerPool((pubkey) => worker?.isLeased(pubkey) ?? false);
  const makeWorker = () =>
    new Worker({
      relayUrl: RELAY,
      state,
      pool,
      gatewayKeys: [getPublicKey(gatewaySecret)],
      providerFor: () => provider,
      price: { input: '1', cachedInput: '0.1', cacheWrite: '1.25', output: '5' },
      reserveUsd: '0.25',
    });
  worker = makeWorker();
  await worker.start();
  check('a pending store is not leased', worker.catalogs.get(store.owner) === undefined);

  // The operator activates it; the running server hears the notify, leases it and publishes its events.
  const publisher = new StoreEventPublisher({
    directory,
    pool,
    relayUrl: RELAY,
    log: console.error,
  });
  const onStoresChanged = () => {
    void worker?.refreshLeases().then(() => publisher.run());
  };
  const unlisten = await db.listen(STORES_CHANNEL, onStoresChanged);
  await runCli(['tier', 'set', 'starter', ...TIER_ARGS], directory);
  await runCli(['store', 'activate', store.owner, '--tier', 'starter'], directory);
  const published = await waitFor(async () => {
    const pending = await directory.unpublishedEvents();
    return pending.length === 0 ? true : undefined;
  }, 15_000);
  check('activation published the stored O-signed events', published === true);
  const loaded = await waitFor(
    async () => (worker?.catalogs.get(store.owner)?.items.size === 2 ? true : undefined),
    15_000,
  );
  check('the activated store is leased and its catalog loaded from the relay', loaded === true);

  const configs = worker.catalogs;
  const server = serveGateway(
    createGateway({
      state,
      gatewaySecretKey: gatewaySecret,
      configFor: (owner) => configs.get(owner)?.config,
      isListed: (owner, address) => isListed(configs.get(owner), address),
      isUnservable: () => false,
      reserveUsd: '0.25',
    }),
    { port: GATEWAY_PORT, trustProxy: false },
  );

  // A headless widget: ticket from the gateway, an ask wrapped to A, the answer on #p = V.
  const visitorSecret = generateSecretKey();
  const visitor = getPublicKey(visitorSecret);
  const sessionResponse = await fetch(`http://localhost:${GATEWAY_PORT}/v1/session`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ store: store.owner, visitor }),
  });
  const session = (await sessionResponse.json()) as { ticket: NostrEvent; assistant: string };
  check(
    'gateway issued a ticket and named A',
    sessionResponse.status === 200 && session.assistant === store.assistant,
  );

  const box = inbox(client, visitorSecret, store.assistant);
  const askId = 'a1'.repeat(16);
  const sendAsk = (id: string, text: string, overrides: { expiresAt?: number } = {}) => {
    const now = nowSecs();
    const { wrap } = wrapChatMessage({
      message: { type: 'ask', ask_id: id, text, ticket: session.ticket },
      senderSecretKey: visitorSecret,
      recipientPubkey: store.assistant,
      maxBackdateSecs: ASSISTANT_WRAP_BACKDATE_SECS,
      expiresAt: overrides.expiresAt ?? now + 3_600,
      now,
    });
    return wrap;
  };
  await publishAll(client, [sendAsk(askId, 'something warm?')]);
  const answer = await waitFor(
    () => box.received.find((message) => message.type === 'answer' && message.ask_id === askId),
    15_000,
  );
  check('the visitor got an answer from A', answer !== undefined);

  // Junk: a wrap to A without an expiration never reaches the turn loop (2.4 pre-check).
  const junkId = 'b2'.repeat(16);
  const junk = sendAsk(junkId, 'junk');
  const stripped = finalizeEvent(
    {
      kind: 1059,
      created_at: junk.created_at,
      content: junk.content,
      tags: [['p', store.assistant]],
    },
    generateSecretKey(),
  );
  await publishAll(client, [stripped]);
  await sleep(3_000);
  check(
    'a wrap without an expiration is dropped before any turn',
    !box.received.some((message) => message.ask_id === junkId) && provider.requests.length === 1,
  );

  // NIP-40 on the relay (4.4): an already expired event is rejected, one that lapses is hidden.
  const expiredNow = finalizeEvent(
    {
      kind: 1059,
      created_at: nowSecs() - 10,
      content: 'x',
      tags: [
        ['p', visitor],
        ['expiration', String(nowSecs() - 1)],
      ],
    },
    generateSecretKey(),
  );
  check(
    'the relay rejects an already expired event',
    (await publishAll(client, [expiredNow]))[0] === false,
  );
  const shortLived = finalizeEvent(
    {
      kind: 1059,
      created_at: nowSecs(),
      content: 'y',
      tags: [
        ['p', visitor],
        ['expiration', String(nowSecs() + 2)],
      ],
    },
    generateSecretKey(),
  );
  await publishAll(client, [shortLived]);
  await sleep(4_000);
  const after = await client.querySync([RELAY], { ids: [shortLived.id] });
  check('the relay hides an event once it expired', after.length === 0);

  // Replay on resubscribe: a restarted worker reads 10 minutes back but answers nothing twice.
  // It gives its lease up on shutdown, so the next one takes it at once with a new epoch.
  await worker.shutdown();
  const answersBefore = box.received.filter((message) => message.type === 'answer').length;
  worker = makeWorker();
  await worker.start();
  await sleep(4_000);
  const answersAfter = box.received.filter((message) => message.type === 'answer').length;
  check(
    'a resubscription replays without answering again',
    answersAfter === answersBefore && provider.requests.length === 1,
  );

  // The same ask id again: the stored exact answer is re-published, no new LLM call (5.8).
  await publishAll(client, [sendAsk(askId, 'something warm?')]);
  await sleep(4_000);
  check(
    'a repeated ask id re-publishes the stored answer without a new turn',
    provider.requests.length === 1,
  );

  await races(db, vault, directory);
  await connectionLoss(db);

  box.close();
  await worker.shutdown();
  await unlisten();
  await db.close();
  server.close();
  client.close([RELAY]);
  execFileSync('docker', ['compose', 'down'], { cwd: HERE, stdio: 'inherit' });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  execFileSync('docker', ['compose', 'down'], { cwd: HERE, stdio: 'inherit' });
  process.exit(1);
});
