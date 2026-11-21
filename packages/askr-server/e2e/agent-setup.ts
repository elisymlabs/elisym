/**
 * End to end of the agent setup (11.2): the `askr` CLI commands, run as the
 * prompt runs them, against a real server (admin API, gateway, worker,
 * publisher) on the e2e relay and Postgres. A new store ends pending, Free
 * activates it on the owner's choice, products from a CSV then the equal JSON
 * (unchanged), a policy, the probe, one chat turn that shows a fixture
 * product, and a re-run of init that signs nothing. Not part of `bun qa`:
 *
 *   bun packages/askr-server/e2e/agent-setup.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as askr from '@elisym/askr';
import type { LlmProvider, TurnRequest, TurnResponse } from '@elisym/askr-agent';
import type { NostrEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { CommandOutcome } from '../../cli/src/commands/askr/errors';
import { type AskrInvocation, runAskrCommand } from '../../cli/src/commands/askr/runner';
import { createAdminApi } from '../src/admin/api';
import { runCli } from '../src/cli';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { type Db, STORES_CHANNEL } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { migrate } from '../src/db/migrations';
import { createPgDb } from '../src/db/pg';
import { type GatewayRequest, createGateway } from '../src/gateway/gateway';
import { serveGateway } from '../src/gateway/http';
import { StoreEventPublisher } from '../src/publisher';
import { createServerPool } from '../src/relay/pool';
import { poolSyncClient } from '../src/relay/sync-client';
import { PgState } from '../src/state/pg-state';
import { StoreDirectory } from '../src/state/stores';
import { isListed } from '../src/worker/catalog';
import { Worker } from '../src/worker/worker';
import { MASTER_KEY, ORIGIN } from '../tests/fixtures';

const RELAY = 'ws://localhost:7447';
const DATABASE_URL = 'postgres://askr:askr@localhost:55432/askr';
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const FREE_TIER_ARGS = [
  '--messages',
  '50',
  '--monthly',
  '100',
  '--tickets',
  '100',
  '--products',
  '100',
  '--sync-minutes',
  '1440',
  '--branding',
  'true',
];
const CSV = [
  'd,title,price,currency,summary,url,topics',
  `mug-1,Stoneware mug,12.50,USD,Holds 350 ml,${ORIGIN}/mug,kitchen`,
  `tee-1,Cotton tee,20,USD,Soft everyday tee,${ORIGIN}/tee,clothing`,
  `cap-1,Wool cap,15,USD,A warm cap,${ORIGIN}/cap,clothing`,
].join('\n');
const FIXTURE_IDS = ['cap-1', 'mug-1', 'tee-1'];

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  failures += ok ? 0 : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForDb(): Promise<Db> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const db = createPgDb(DATABASE_URL, (message) => console.error(message));
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

/** A model that searches, shows the mug's card, then answers: the turn loop's tools decide the rest. */
function cardProvider(): LlmProvider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };
  const steps: TurnResponse[] = [
    {
      text: '',
      toolCalls: [
        { type: 'tool_use', id: 'tool-1', name: 'search_products', input: { query: 'mug' } },
      ],
      stopReason: 'tool_use',
      usage,
    },
    {
      text: '',
      toolCalls: [
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'present_products',
          input: { picks: [{ id: 'mug-1', reason: 'holds 350 ml' }] },
        },
      ],
      stopReason: 'tool_use',
      usage,
    },
    { text: 'The stoneware mug fits.', toolCalls: [], stopReason: 'end_turn', usage },
  ];
  return {
    model: 'scripted-card',
    requests,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step === undefined) {
        throw new Error('no step');
      }
      return step;
    },
  };
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
  await runCli(['tier', 'set', 'free', ...FREE_TIER_ARGS], directory);

  const gatewaySecretKey = generateSecretKey();
  const provider = cardProvider();
  let leasedBy: Worker | undefined;
  const pool = createServerPool((pubkey) => leasedBy?.isLeased(pubkey) ?? false);
  const worker = new Worker({
    relayUrl: RELAY,
    state,
    pool,
    gatewayKeys: [getPublicKey(gatewaySecretKey)],
    providerFor: () => provider,
    price: { input: '1', cachedInput: '0.1', cacheWrite: '1.25', output: '5' },
    reserveUsd: '0.25',
  });
  leasedBy = worker;
  const publisher = new StoreEventPublisher({
    directory,
    pool,
    relayUrl: RELAY,
    log: console.error,
  });
  const syncClient = poolSyncClient(pool, RELAY);
  const catalogs = worker.catalogs;
  const connectors = new ConnectorService({
    directory,
    holder: worker.holderId,
    client: syncClient,
    configFor: (owner) => catalogs.get(owner)?.config,
    limiter: new ShopRateLimiter(),
    log: console.error,
  });
  await worker.start();
  const onStoresChanged = () => {
    worker
      .refreshLeases()
      .then(() => publisher.run())
      .then(() => connectors.refresh())
      .catch((error: unknown) => console.error('store change handling failed', error));
  };
  const unlisten = await db.listen(STORES_CHANNEL, onStoresChanged);
  const gateway = createGateway({
    state,
    gatewaySecretKey,
    configFor: (owner) => catalogs.get(owner)?.config,
    isListed: (owner, address) => isListed(catalogs.get(owner), address),
    isUnservable: (owner) => worker.isUnservable(owner),
  });
  const admin = createAdminApi({
    directory,
    publicBase: BASE,
    syncClient,
    storeEventsChanged: onStoresChanged,
    connectors,
    freeTier: { tier: 'free', perDay: 5, maxActive: 5 },
    syncPace: 50,
    log: console.error,
  });
  const handler = async (input: GatewayRequest): Promise<Response> =>
    (await admin(input)) ?? gateway(input);
  const server = serveGateway(handler, { port: PORT, trustProxy: false });

  const home = await mkdtemp(join(tmpdir(), 'askr-agent-setup-'));
  const files = await mkdtemp(join(tmpdir(), 'askr-agent-files-'));
  const cli = (invocation: AskrInvocation, args: string[]): Promise<CommandOutcome> =>
    runAskrCommand(
      invocation,
      { args },
      {
        loadAskr: async () => askr,
        deps: (module) => ({
          fetch: (input, init) => globalThis.fetch(input, init),
          connectRelay: (url) => module.connectSyncClient(url),
          now: () => Date.now(),
          home,
          env: { ELISYM_ASKR_API: BASE, ELISYM_ASKR_RELAY: RELAY },
          notice: () => undefined,
        }),
        io: {
          write: (line, flushed) => process.stdout.write(`cli: ${line}`, () => flushed()),
          exit: () => undefined,
        },
        hasWebSocket: () => 'WebSocket' in globalThis,
      },
    );

  const initArgs = ['init', '--name', 'Example Shop', '--origin', ORIGIN, '--currency', 'USD'];
  const initOptions = { name: 'Example Shop', origin: [ORIGIN], currency: 'USD' };
  const init = await cli({ command: 'init', options: initOptions }, initArgs);
  check(
    'init: a new store ends pending, awaiting a plan, settings and authorization signed',
    init.exitCode === 0 &&
      init.output.status === 'pending' &&
      init.output.awaitingPlan === true &&
      init.output.config === 'signed' &&
      init.output.authorization === 'signed',
  );
  const storeId = String(init.output.storeId);
  const decoded = decode(storeId);
  const owner = decoded.type === 'npub' ? decoded.data : '';

  const plan = await cli({ command: 'plan', plan: 'free' }, ['plan', 'free']);
  check(
    'plan free: active on free, its stored events published',
    plan.exitCode === 0 &&
      plan.output.status === 'active' &&
      plan.output.activation === 'activated' &&
      plan.output.published === true,
  );

  const csvPath = join(files, 'products.csv');
  await writeFile(csvPath, CSV);
  const fromCsv = await cli({ command: 'products', options: { file: csvPath } }, [
    'products',
    '--file',
    csvPath,
  ]);
  check(
    'products from the CSV: three created, synced',
    fromCsv.exitCode === 0 && fromCsv.output.created === 3 && fromCsv.output.sync === 'done',
  );
  const jsonPath = join(files, 'products.json');
  await writeFile(jsonPath, JSON.stringify(askr.productsFromCsv(CSV, 'USD').items));
  const fromJson = await cli({ command: 'products', options: { file: jsonPath } }, [
    'products',
    '--file',
    jsonPath,
  ]);
  check(
    'the equal JSON file: nothing changed',
    fromJson.exitCode === 0 &&
      fromJson.output.created === 0 &&
      fromJson.output.updated === 0 &&
      fromJson.output.unchanged === 3,
  );

  const policyPath = join(files, 'returns.md');
  await writeFile(policyPath, 'Returns within 30 days, unused.');
  const policy = await cli(
    { command: 'policy', options: { slug: 'returns', title: 'Returns', file: policyPath } },
    ['policy', '--slug', 'returns', '--title', 'Returns', '--file', policyPath],
  );
  check('policy published by server K', policy.exitCode === 0 && policy.output.slug === 'returns');

  const record = await directory.store(owner);
  const listed =
    record === undefined
      ? []
      : await client.querySync([RELAY], { kinds: [30402], authors: [record.catalogKey] });
  const ids = [
    ...new Set(listed.map((event) => event.tags.find((tag) => tag[0] === 'd')?.[1])),
  ].sort();
  check(
    'server K lists exactly the fixture products on the relay',
    JSON.stringify(ids) === JSON.stringify(FIXTURE_IDS),
  );

  const status = await cli({ command: 'status', options: { probe: true } }, ['status', '--probe']);
  const tier = status.output.tier;
  check(
    'status --probe: active on free, three listed, the policy, the probe ok',
    status.exitCode === 0 &&
      status.output.status === 'active' &&
      typeof tier === 'object' &&
      tier !== null &&
      'name' in tier &&
      tier.name === 'free' &&
      JSON.stringify(status.output.products) === JSON.stringify({ listed: 3, visible: 3 }) &&
      JSON.stringify(status.output.policies) === JSON.stringify(['returns']) &&
      JSON.stringify(status.output.probe) === JSON.stringify({ origin: ORIGIN, result: 'ok' }),
  );

  // One chat turn as the widget makes it: a ticket for ORIGIN, an ask wrapped to A.
  const visitorSecret = generateSecretKey();
  const sessionResponse = await fetch(`${BASE}/v1/session`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ store: owner, visitor: getPublicKey(visitorSecret) }),
  });
  const session: { ticket: NostrEvent; assistant: string } = await sessionResponse.json();
  const answers: askr.ChatMessage[] = [];
  const closer = client.subscribe(
    [RELAY],
    { kinds: [1059], '#p': [getPublicKey(visitorSecret)] },
    {
      onevent: (event) => {
        const opened = askr.unwrapChatMessage(event, visitorSecret);
        if (opened && opened.senderPubkey === session.assistant) {
          answers.push(opened.message);
        }
      },
    },
  );
  const askId = 'c3'.repeat(16);
  const now = Math.floor(Date.now() / 1000);
  const { wrap } = askr.wrapChatMessage({
    message: { type: 'ask', ask_id: askId, text: 'a mug?', ticket: session.ticket },
    senderSecretKey: visitorSecret,
    recipientPubkey: session.assistant,
    maxBackdateSecs: askr.ASSISTANT_WRAP_BACKDATE_SECS,
    expiresAt: now + 3_600,
    now,
  });
  await Promise.any(client.publish([RELAY], wrap));
  const answer = await waitFor(
    () => answers.find((message) => message.type === 'answer' && message.ask_id === askId),
    20_000,
  );
  const mugAddress = record === undefined ? '' : `30402:${record.catalogKey}:mug-1`;
  check(
    'a chat turn answers with the fixture mug as a product card',
    answer !== undefined && JSON.stringify(answer).includes(mugAddress),
  );
  closer.close();

  const storedCount = async (): Promise<number> => {
    const [row] = await db.query<{ count: number }>(
      'select count(*)::int8 as count from store_events where owner = $1',
      [owner],
    );
    return Number(row?.count ?? -1);
  };
  const storedBefore = await storedCount();
  const again = await cli({ command: 'init', options: initOptions }, initArgs);
  check(
    'a re-run of the same init line signs and stores nothing',
    again.exitCode === 0 &&
      again.output.config === 'unchanged' &&
      again.output.authorization === 'present' &&
      again.output.published === true &&
      (await storedCount()) === storedBefore,
  );

  server.close();
  connectors.stop();
  await unlisten();
  await worker.shutdown();
  await db.close();
  client.close([RELAY]);
  await rm(home, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
  execFileSync('docker', ['compose', 'down'], { cwd: HERE, stdio: 'inherit' });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  execFileSync('docker', ['compose', 'down'], { cwd: HERE, stdio: 'inherit' });
  process.exit(1);
});
