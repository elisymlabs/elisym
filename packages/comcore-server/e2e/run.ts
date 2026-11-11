/**
 * Phase 2 end to end (2.4, 4.4): the marketplace relay config in Docker, a
 * synthetic store, the gateway and a worker with a scripted model, and a
 * headless widget client. Not part of `bun qa` (CI has no Docker):
 *
 *   bun packages/comcore-server/e2e/run.ts
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_WRAP_BACKDATE_SECS,
  type ChatMessage,
  unwrapChatMessage,
  wrapChatMessage,
} from '@elisym/comcore';
import type { NostrEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createGateway } from '../src/gateway/gateway';
import { serveGateway } from '../src/gateway/http';
import { createServerPool } from '../src/relay/pool';
import { MemoryState } from '../src/state/memory';
import { isListed } from '../src/worker/catalog';
import { Worker } from '../src/worker/worker';
import { ORIGIN, scriptedProvider, storeRecord, syntheticStore } from '../tests/fixtures';

const RELAY = 'ws://localhost:7447';
const GATEWAY_PORT = 8799;
const here = dirname(fileURLToPath(import.meta.url));
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(200);
  }
  return undefined;
}

async function main(): Promise<void> {
  execFileSync('docker', ['compose', 'up', '-d', '--force-recreate'], {
    cwd: here,
    stdio: 'inherit',
  });
  const client = new SimplePool();
  await waitForRelay(client);

  const store = syntheticStore(nowSecs());
  check(
    'store events accepted by the relay',
    (await publishAll(client, store.events)).every(Boolean),
  );

  const state = new MemoryState([storeRecord(store)]);
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
  check(
    'worker loaded the catalog from the relay',
    worker.catalogs.get(store.owner)?.items.size === 2,
  );

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
  worker.stop();
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

  box.close();
  worker.stop();
  server.close();
  client.close([RELAY]);
  execFileSync('docker', ['compose', 'down'], { cwd: here, stdio: 'inherit' });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  execFileSync('docker', ['compose', 'down'], { cwd: here, stdio: 'inherit' });
  process.exit(1);
});
