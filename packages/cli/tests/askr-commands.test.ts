import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREE_TIER,
  activeStore,
  product,
  writeCsv,
  writeJson,
  INIT_ARGS,
  ORIGIN,
  cleanupHomes,
  harness,
  initInvocation,
  json,
  tempDir,
  type Harness,
} from './askr-fake';

const CHOOSE_PLAN = 'choose a plan: askr plan free';
const NOT_AUTHORIZED = 'This key is not authorized as a catalog key by the store owner';

// Each case runs whole commands (key files, signing, many calls): slower than a unit under a loaded `bun qa`.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanupHomes();
});

describe('askr plan', () => {
  it('free activates, waits for publication and answers active', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const outcome = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    expect(outcome).toMatchObject({
      exitCode: 0,
      output: {
        ok: true,
        status: 'active',
        tier: FREE_TIER,
        activation: 'activated',
        published: true,
      },
    });
    const again = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    expect(again.output).toMatchObject({ activation: 'already_active', published: true });
  });

  it('an unknown plan, or --yearly with free, is exit 1 and no request is sent', async () => {
    const setup = await harness();
    const outcome = await setup.run({ command: 'plan', plan: 'enterprise' }, [
      'plan',
      'enterprise',
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output).toMatchObject({
      error: { code: 'unknown_plan' },
      upgrade: { contact: 'https://askr.elisym.network/contact' },
    });
    const yearly = await setup.run({ command: 'plan', plan: 'free', options: { yearly: true } }, [
      'plan',
      'free',
      '--yearly',
    ]);
    expect(yearly).toMatchObject({ exitCode: 1, output: { error: { code: 'bad_flag' } } });
    expect(setup.fake.calls).toHaveLength(0);
  });

  it('a paid plan prints the checkout link for the human, monthly or yearly, and opens nothing', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.billing = { enabled: true, checkoutAvailable: true };
    const monthly = await setup.run({ command: 'plan', plan: 'growth' }, ['plan', 'growth']);
    expect(monthly).toMatchObject({
      exitCode: 0,
      output: {
        ok: true,
        plan: 'growth',
        interval: 'month',
        checkoutUrl: 'https://checkout.stripe.test/c/growth-month',
      },
    });
    expect(String(monthly.output.hint)).toContain('never open it yourself');
    const yearly = await setup.run({ command: 'plan', plan: 'scale', options: { yearly: true } }, [
      'plan',
      'scale',
      '--yearly',
    ]);
    expect(yearly.output).toMatchObject({
      interval: 'year',
      checkoutUrl: 'https://checkout.stripe.test/c/scale-year',
    });
    expect(
      setup.fake.routeCalls('POST /v1/admin/billing/checkout').map((call) => call.body),
    ).toEqual([
      { plan: 'growth', interval: 'month' },
      { plan: 'scale', interval: 'year' },
    ]);
    expect(setup.fake.routeCalls('POST /v1/admin/store/plan')).toHaveLength(0);
  });

  it('maps every checkout refusal', async () => {
    const cases: Array<[Response, number, string]> = [
      [json({ error: 'billing_unavailable' }, 503), 5, 'billing_unavailable'],
      [json({ error: 'plan_unavailable' }, 503), 5, 'plan_unavailable'],
      [json({ error: 'subscription_exists' }, 409), 3, 'subscription_exists'],
      [json({ error: 'operator_managed' }, 409), 3, 'operator_managed'],
      [json({ error: 'suspended' }, 409), 3, 'suspended'],
      [json({ error: 'moved' }, 409), 3, 'moved_store'],
      [json({ error: 'billing_failed' }, 502), 4, 'billing_failed'],
    ];
    for (const [answer, exitCode, code] of cases) {
      const setup = await harness();
      await setup.run(initInvocation(), INIT_ARGS);
      setup.fake.on('POST /v1/admin/billing/checkout', () => answer.clone());
      const outcome = await setup.run({ command: 'plan', plan: 'pro' }, ['plan', 'pro']);
      expect(outcome.exitCode, code).toBe(exitCode);
      expect(outcome.output).toMatchObject({ error: { code } });
      if (code === 'subscription_exists') {
        const hint = String(Reflect.get(Object(outcome.output.error), 'hint'));
        expect(hint).toContain('Manage billing');
        expect(hint).toMatch(/in the admin \(https?:\/\/[^)]+\/admin\/\)$/u);
      }
    }
    const off = await harness();
    await off.run(initInvocation(), INIT_ARGS);
    const outcome = await off.run({ command: 'plan', plan: 'starter' }, ['plan', 'starter']);
    expect(outcome.output).toMatchObject({
      error: { code: 'billing_unavailable', hint: expect.stringContaining('message us') },
      upgrade: { contact: 'https://askr.elisym.network/contact' },
    });
  });

  it('maps every server answer of 5.9', async () => {
    const cases: Array<[Response, number, string, boolean]> = [
      [json({ error: 'capacity_reached' }, 409), 5, 'capacity_reached', true],
      [json({ error: 'free_unavailable' }, 409), 5, 'free_unavailable', false],
      [json({ error: 'no_settings' }, 409), 1, 'no_settings', false],
      [json({ error: 'no_store' }, 404), 1, 'no_store', false],
      [json({ error: 'not_pending' }, 409), 3, 'not_pending', false],
      [json({ error: 'operator_managed' }, 409), 3, 'operator_managed', false],
      [json({ error: 'moved' }, 409), 3, 'moved_store', false],
      [json({ error: 'read_failed' }, 503), 4, 'read_failed', true],
    ];
    for (const [answer, exitCode, code, resumes] of cases) {
      const setup = await harness();
      await setup.run(initInvocation(), INIT_ARGS);
      setup.fake.on('POST /v1/admin/store/plan', () => answer.clone());
      const outcome = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
      expect(outcome.exitCode, code).toBe(exitCode);
      expect(outcome.output).toMatchObject({ error: { code } });
      expect(outcome.output.resume, code).toBe(
        resumes ? 'npx -y @elisym/cli@latest askr plan free' : undefined,
      );
    }
  });

  it('publication still pending at the deadline is exit 4 resuming plan free', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.holdPublication = true;
    const outcome = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: { published: false, resume: 'npx -y @elisym/cli@latest askr plan free' },
    });
  });

  it('a stopped event ends the wait as publish_stopped (exit 3)', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.holdPublication = true;
    for (const entry of setup.fake.stored) {
      entry.stopped = true;
    }
    const outcome = await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    expect(outcome).toMatchObject({ exitCode: 3, output: { error: { code: 'publish_stopped' } } });
  });
});

describe('writes on a store that is not active', () => {
  it('products, policy and connector on a never-tiered pending store: exit 5 with the choose-a-plan hint', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const file = await writeJson([product('a')]);
    const policy = join(await tempDir(), 'returns.md');
    await writeFile(policy, '30 days.');
    for (const invocation of [
      { command: 'products' as const, options: { file } },
      { command: 'policy' as const, options: { slug: 'returns', title: 'Returns', file: policy } },
      { command: 'connector' as const },
    ]) {
      const outcome = await setup.run(invocation, [invocation.command]);
      expect(outcome.exitCode).toBe(5);
      expect(outcome.output).toMatchObject({ error: { code: 'inactive' }, awaitingPlan: true });
      expect(JSON.stringify(outcome.output)).toContain(CHOOSE_PLAN);
    }
  });

  it('products --dry-run on a pending store checks the file here and publishes nothing', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const file = await writeJson([
      product('a'),
      product('b', { url: 'https://elsewhere.example/b' }),
    ]);
    const outcome = await setup.run({ command: 'products', options: { file, dryRun: true } }, [
      'products',
    ]);
    expect(outcome).toMatchObject({
      exitCode: 0,
      output: {
        ok: true,
        dryRun: true,
        checked: 'local',
        published: false,
        inFile: 2,
        created: 2,
        alreadyListed: 0,
        hidden: 0,
        sample: { created: ['a', 'b'], hidden: [] },
        urlWarnings: [{ d: 'b', url: 'https://elsewhere.example/b' }],
      },
    });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);

    const rows = await writeCsv('d,title,price\na,,10\n');
    const badRows = await setup.run(
      { command: 'products', options: { file: rows, dryRun: true } },
      ['products'],
    );
    expect(badRows).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_rows' } } });
  });

  it('a pending dry run hides listed products missing from the file only with --replace', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.seedProducts([product('old'), product('a')]);
    const file = await writeJson([product('a'), product('new')]);
    const upsert = await setup.run({ command: 'products', options: { file, dryRun: true } }, [
      'products',
    ]);
    expect(upsert.output).toMatchObject({
      checked: 'local',
      mode: 'upsert',
      created: 1,
      alreadyListed: 1,
      hidden: 0,
      sample: { created: ['new'], hidden: [] },
    });
    const replace = await setup.run(
      { command: 'products', options: { file, dryRun: true, replace: true } },
      ['products'],
    );
    expect(replace.output).toMatchObject({
      checked: 'local',
      mode: 'replace',
      hidden: 1,
      sample: { hidden: ['old'] },
    });
  });

  it('a JSON file that repeats a product id is invalid_file, naming the ids, before any call', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const callsBefore = setup.fake.calls.length;
    const file = await writeJson([product('a'), product('b'), product('a'), product('b')]);
    const outcome = await setup.run({ command: 'products', options: { file, dryRun: true } }, [
      'products',
    ]);
    expect(outcome).toMatchObject({
      exitCode: 1,
      output: { error: { code: 'invalid_file' }, repeated: ['a', 'b'] },
    });
    expect(setup.fake.calls).toHaveLength(callsBefore);
  });

  it('products --dry-run on a suspended store is still refused', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.status = 'suspended';
    setup.fake.tier = FREE_TIER;
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file, dryRun: true } }, [
      'products',
    ]);
    expect(outcome).toMatchObject({ exitCode: 5, output: { error: { code: 'inactive' } } });
  });

  it('on a suspended or operator-managed store: exit 5 with the contact hint, never askr plan free', async () => {
    for (const [status, tier] of [
      ['suspended', FREE_TIER],
      ['pending', FREE_TIER],
    ] as const) {
      const setup = await harness();
      await setup.run(initInvocation(), INIT_ARGS);
      setup.fake.status = status;
      setup.fake.tier = tier;
      const file = await writeJson([product('a')]);
      const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
      expect(outcome.exitCode).toBe(5);
      const text = JSON.stringify(outcome.output);
      expect(text).toContain('message us with your Store ID');
      expect(text).not.toContain('plan free');
    }
  });
});

describe('askr products', () => {
  it('JSON and CSV give the same items; a CSV without currency takes the store currency', async () => {
    const setup = await activeStore();
    const csv = await writeCsv('d,title,price,url\na,Product a,10,https://shop.example/p/a\n');
    const fromCsv = await setup.run({ command: 'products', options: { file: csv } }, ['products']);
    expect(fromCsv.output).toMatchObject({ ok: true, created: 1, sync: 'done', inFile: 1 });
    const json = await writeJson({ items: [product('a')] });
    const fromJson = await setup.run({ command: 'products', options: { file: json } }, [
      'products',
    ]);
    expect(fromJson.output).toMatchObject({ created: 0, updated: 0, unchanged: 1, sync: 'done' });
    const sent = setup.fake.routeCalls('POST /v1/admin/catalog')[0]?.body;
    expect(JSON.stringify(sent)).toContain('"currency":"EUR"');
  });

  it('reports CSV line errors with exit 1', async () => {
    const setup = await activeStore();
    const csv = await writeCsv('d,title,price\na,,10\n');
    const outcome = await setup.run({ command: 'products', options: { file: csv } }, ['products']);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output).toMatchObject({ error: { code: 'invalid_rows' } });
  });

  it('a missing or malformed file is exit 1 before any key or call', async () => {
    const setup = await harness();
    const missing = await setup.run(
      { command: 'products', options: { file: '/nonexistent.json' } },
      ['products'],
    );
    expect(missing).toMatchObject({ exitCode: 1, output: { error: { code: 'file_not_found' } } });
    const bad = await writeJson([{ d: 'a' }]);
    const invalid = await setup.run({ command: 'products', options: { file: bad } }, ['products']);
    expect(invalid).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_file' } } });
    expect(setup.fake.calls).toHaveLength(0);
  });

  it('refuses a connector source (wrong_source, exit 3)', async () => {
    const setup = await activeStore({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN });
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 3, output: { error: { code: 'wrong_source' } } });
  });

  it('warns about links off the store origins, not on them', async () => {
    const setup = await activeStore();
    const file = await writeJson([
      product('a'),
      product('b', { url: 'https://elsewhere.example/b' }),
    ]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output.urlWarnings).toEqual([{ d: 'b', url: 'https://elsewhere.example/b' }]);
  });

  it('a JSON file over 8 MB is invalid_file, exit 1, before sending', async () => {
    const setup = await activeStore();
    const long = 'x'.repeat(60_000);
    const items = Array.from({ length: 150 }, (_, index) =>
      product(`p${index}`, { description: long }),
    );
    const file = await writeJson(items);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'invalid_file' } } });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);
  });

  it('a CSV under its size cap whose request body grows past 8 MB is body_too_large, nothing sent', async () => {
    const setup = await activeStore();
    // A quoted newline is one byte in the CSV and two in the JSON body (\n).
    const description = `"${'a\n'.repeat(30_000)}"`;
    const rows = Array.from(
      { length: 100 },
      (_, index) => `p${index},Product ${index},10,${description}`,
    );
    const file = await writeCsv(['d,title,price,description', ...rows].join('\n'));
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'body_too_large' } } });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(0);
  });

  it('--replace without --allow-hide stops after the dry run, listing what would be hidden', async () => {
    const setup = await activeStore();
    setup.fake.seedProducts([product('old')]);
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file, replace: true } }, [
      'products',
      '--replace',
    ]);
    expect(outcome).toMatchObject({
      exitCode: 1,
      output: { error: { code: 'would_hide' }, wouldHide: ['old'] },
    });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(1);
    const allowed = await setup.run(
      { command: 'products', options: { file, replace: true, allowHide: true } },
      ['products'],
    );
    expect(allowed.output).toMatchObject({ hidden: 1, sync: 'done' });
  });

  it('warns on an upsert that leaves many listed products out, and counts visibleInFile', async () => {
    const setup = await activeStore();
    setup.fake.seedProducts(Array.from({ length: 12 }, (_, index) => product(`old${index}`)));
    const file = await writeJson([product('a'), product('h', { visibility: 'hidden' })]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output).toMatchObject({ inFile: 2, visibleInFile: 1 });
    expect(String(outcome.output.warning)).toContain('12 listed products are not in this file');
  });

  it('still running at the deadline is ok with sync running; failed is exit 4 resuming the same line', async () => {
    const setup = await activeStore();
    setup.fake.syncEnds = 'running';
    const file = await writeJson([product('a')]);
    const started = Date.now();
    const running = await setup.run({ command: 'products', options: { file } }, [
      'products',
      '--file',
      file,
    ]);
    expect(Date.now() - started).toBeLessThanOrEqual(85_000);
    expect(running).toMatchObject({
      exitCode: 0,
      output: { ok: true, sync: 'running', next: 'askr status' },
    });
    const failing = await activeStore();
    failing.fake.syncEnds = 'failed';
    const failed = await failing.run({ command: 'products', options: { file } }, [
      'products',
      '--file',
      file,
    ]);
    expect(failed).toMatchObject({
      exitCode: 4,
      output: {
        error: { code: 'sync_failed' },
        resume: `npx -y @elisym/cli@latest askr products --file ${file}`,
      },
    });
  });

  it('retries the not-authorized refusal, then succeeds', async () => {
    const setup = await activeStore();
    let refusals = 2;
    setup.fake.on('POST /v1/admin/catalog', () => {
      if (refusals > 0) {
        refusals -= 1;
        return json({ error: 'sync_refused', message: NOT_AUTHORIZED }, 409);
      }
      return undefined;
    });
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output).toMatchObject({ ok: true, sync: 'done' });
  });

  it('another sync_refused message is exit 4 with it and no retry inside the command', async () => {
    const setup = await activeStore();
    setup.fake.on('POST /v1/admin/catalog', () =>
      json({ error: 'sync_refused', message: 'The relay did not answer the whole read' }, 409),
    );
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, [
      'products',
      '--file',
      file,
    ]);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: {
        error: { code: 'sync_refused', message: 'The relay did not answer the whole read' },
        resume: `npx -y @elisym/cli@latest askr products --file ${file}`,
      },
    });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(1);
  });

  it('too_many_products is exit 5 with the upgrade block', async () => {
    const setup = await activeStore();
    setup.fake.tier = { ...FREE_TIER, maxProducts: 1 };
    const file = await writeJson([product('a'), product('b')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({
      exitCode: 5,
      output: {
        error: { code: 'too_many_products' },
        max: 1,
        upgrade: { howTo: 'Message us with your Store ID' },
      },
    });
  });

  it('fewer than 20 s left before the real call: exit 4, the real call never sent', async () => {
    const setup = await activeStore();
    setup.fake.on('POST /v1/admin/catalog', async () => {
      await new Promise((resolve) => setTimeout(resolve, 70_000));
      return undefined;
    });
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome).toMatchObject({ exitCode: 4, output: { error: { code: 'deadline' } } });
    const real = setup.fake
      .routeCalls('POST /v1/admin/catalog')
      .filter((call) => JSON.stringify(call.body).includes('"dryRun":false'));
    expect(real).toHaveLength(0);
  });

  it('sync_running: waits until no sync runs, then dry runs again (empty diff: done)', async () => {
    const setup = await activeStore();
    const file = await writeJson([product('a')]);
    await setup.run({ command: 'products', options: { file } }, ['products']);
    let busy = 1;
    setup.fake.on('POST /v1/admin/catalog', () => {
      if (busy > 0) {
        busy -= 1;
        setup.fake.catalogSync = { state: 'running', diff: {} };
        setTimeout(() => {
          setup.fake.catalogSync = { state: 'done', diff: {} };
        }, 5_000);
        return json({ error: 'sync_running' }, 409);
      }
      return undefined;
    });
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output).toMatchObject({ ok: true, sync: 'done', unchanged: 1 });
  });

  it('a dry run answering 409 while catalogSync never runs repeats until the deadline, then exit 4', async () => {
    const setup = await activeStore();
    setup.fake.on('POST /v1/admin/catalog', () => json({ error: 'sync_running' }, 409));
    const file = await writeJson([product('a')]);
    const started = Date.now();
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(Date.now() - started).toBeLessThanOrEqual(85_000);
    expect(outcome).toMatchObject({ exitCode: 4, output: { error: { code: 'sync_running' } } });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog').length).toBeGreaterThan(5);
  });

  it('--dry-run reports the counts and publishes nothing', async () => {
    const setup = await activeStore();
    const published = await writeJson([product('a'), product('b')]);
    await setup.run({ command: 'products', options: { file: published } }, ['products']);
    const before = setup.fake.routeCalls('POST /v1/admin/catalog').length;
    const file = await writeJson([product('a', { title: 'Changed' }), product('c')]);
    const outcome = await setup.run(
      { command: 'products', options: { file, dryRun: true, replace: true } },
      ['products', '--file', file, '--dry-run', '--replace'],
    );
    expect(outcome).toMatchObject({
      exitCode: 0,
      output: { ok: true, created: 1, updated: 1, hidden: 1 },
    });
    const sent = setup.fake.routeCalls('POST /v1/admin/catalog').slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) {
      expect(JSON.stringify(call.body)).not.toContain('"dryRun":false');
    }
    const status = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(status.output).toMatchObject({ products: { listed: 2 } });
  });

  it('--dry-run with sync_running is exit 4 at once, no waiting', async () => {
    const setup = await activeStore();
    setup.fake.on('POST /v1/admin/catalog', () => json({ error: 'sync_running' }, 409));
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file, dryRun: true } }, [
      'products',
      '--file',
      file,
      '--dry-run',
    ]);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: { resume: `npx -y @elisym/cli@latest askr products --file ${file} --dry-run` },
    });
    expect(setup.fake.routeCalls('POST /v1/admin/catalog')).toHaveLength(1);
  });
});

describe('askr policy', () => {
  async function policyFile(): Promise<string> {
    const path = join(await tempDir(), 'returns.md');
    await writeFile(path, 'Returns within 30 days.');
    return path;
  }

  it('publishes through server K', async () => {
    const setup = await activeStore();
    const file = await policyFile();
    const outcome = await setup.run(
      { command: 'policy', options: { slug: 'returns', title: 'Returns', file } },
      ['policy'],
    );
    expect(outcome.output).toMatchObject({ ok: true, slug: 'returns' });
    const status = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(status.output.policies).toEqual(['returns']);
  });

  it('retries the not-authorized refusal; another publish_refused is exit 4; imported is exit 3', async () => {
    const setup = await activeStore();
    const file = await policyFile();
    let refusals = 1;
    setup.fake.on('PUT /v1/admin/policies/returns', () => {
      if (refusals > 0) {
        refusals -= 1;
        return json({ error: 'publish_refused', message: NOT_AUTHORIZED }, 409);
      }
      return undefined;
    });
    const retried = await setup.run(
      { command: 'policy', options: { slug: 'returns', title: 'Returns', file } },
      ['policy'],
    );
    expect(retried.exitCode).toBe(0);
    setup.fake.on('PUT /v1/admin/policies/faq', () =>
      json({ error: 'publish_refused', message: 'relay down' }, 409),
    );
    const refused = await setup.run(
      { command: 'policy', options: { slug: 'faq', title: 'FAQ', file } },
      ['policy', '--slug', 'faq'],
    );
    expect(refused).toMatchObject({
      exitCode: 4,
      output: {
        error: { message: 'relay down' },
        resume: 'npx -y @elisym/cli@latest askr policy --slug faq',
      },
    });
    setup.fake.on('PUT /v1/admin/policies/shipping', () => json({ error: 'policy_imported' }, 409));
    const imported = await setup.run(
      { command: 'policy', options: { slug: 'shipping', title: 'Shipping', file } },
      ['policy'],
    );
    expect(imported).toMatchObject({ exitCode: 3, output: { error: { code: 'policy_imported' } } });
  });
});

describe('askr connector', () => {
  async function connectorStore(): Promise<Harness> {
    return activeStore({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN });
  }

  it('preview ok, enable, then a newer run decides the exit', async () => {
    const cases: Array<[unknown, number, string | undefined]> = [
      [
        { status: 'ok', diff: { created: ['a'], updated: [], hidden: [], unchanged: [] } },
        0,
        undefined,
      ],
      [{ status: 'verification_failed', failures: [] }, 1, 'verification_failed'],
      [
        { status: 'source_closed', url: ORIGIN, reason: '403', httpStatus: 403 },
        3,
        'source_closed',
      ],
      [{ status: 'error', message: 'boom' }, 3, 'error'],
      [
        { status: 'error', message: 'big', reason: 'too_many_products', count: 300, max: 100 },
        5,
        'too_many_products',
      ],
    ];
    for (const [run, exitCode, code] of cases) {
      const setup = await connectorStore();
      setup.fake.runResult = run;
      const outcome = await setup.run({ command: 'connector' }, ['connector']);
      expect(outcome.exitCode, code).toBe(exitCode);
      if (code !== undefined) {
        expect(outcome.output).toMatchObject({ error: { code } });
      } else {
        expect(outcome.output).toMatchObject({
          ok: true,
          enabled: true,
          lastRun: { status: 'ok', created: 1 },
        });
      }
      expect(setup.fake.routeCalls('POST /v1/admin/connector/enable')).toHaveLength(1);
    }
  });

  it('an older lastRunAt is not taken as the new run; never seen is exit 4 resuming status', async () => {
    const setup = await connectorStore();
    if (setup.fake.connector !== null) {
      setup.fake.connector.lastRunAt = 1_000;
      setup.fake.connector.lastStatus = {
        status: 'ok',
        diff: { created: [], updated: [], hidden: [], unchanged: [] },
      };
    }
    const outcome = await setup.run({ command: 'connector' }, ['connector']);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: {
        enabled: true,
        lastRunAtBefore: 1_000,
        resume: 'npx -y @elisym/cli@latest askr status',
      },
    });
  });

  it('a preview that fails verification never enables', async () => {
    const setup = await connectorStore();
    setup.fake.previewResult = {
      status: 'verification_failed',
      failures: [{ origin: ORIGIN, reason: 'not_found' }],
    };
    const outcome = await setup.run({ command: 'connector' }, ['connector']);
    expect(outcome).toMatchObject({
      exitCode: 1,
      output: { error: { code: 'verification_failed' } },
    });
    expect(setup.fake.routeCalls('POST /v1/admin/connector/enable')).toHaveLength(0);
  });

  it('a preview not answered within 70 s is exit 4 with retryAfterSeconds 90 and the slow-shop hint', async () => {
    const setup = await connectorStore();
    setup.fake.on('POST /v1/admin/connector/preview', () => new Promise<Response>(() => undefined));
    const outcome = await setup.run({ command: 'connector' }, ['connector']);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: { retryAfterSeconds: 90, resume: 'npx -y @elisym/cli@latest askr connector' },
    });
    expect(JSON.stringify(outcome.output)).toContain('Connector tab');
  });

  it('a run stored as sync_busy is exit 4 resuming connector; the resume after it waits 150 s', async () => {
    const setup = await connectorStore();
    setup.fake.runResult = {
      status: 'error',
      message: 'Another catalog sync of this store is running',
    };
    const busy = await setup.run({ command: 'connector' }, ['connector']);
    expect(busy).toMatchObject({
      exitCode: 4,
      output: {
        error: { code: 'sync_busy' },
        retryAfterSeconds: 60,
        resume: 'npx -y @elisym/cli@latest askr connector',
      },
    });
    const status = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(status.output.connector).toMatchObject({ lastReason: 'sync_busy', lastStatus: 'error' });
    setup.fake.on('POST /v1/admin/connector/preview', () => json({ error: 'sync_running' }, 409));
    const resumed = await setup.run({ command: 'connector' }, ['connector']);
    expect(resumed).toMatchObject({
      exitCode: 4,
      output: { retryAfterSeconds: 150, resume: 'npx -y @elisym/cli@latest askr connector' },
    });
    if (setup.fake.connector !== null) {
      setup.fake.connector.lastStatus = { status: 'ok', diff: {} };
    }
    const running = await setup.run({ command: 'connector' }, ['connector']);
    expect(running.output.resume).toBe('npx -y @elisym/cli@latest askr status');
  });

  it('sync_running before it was ever enabled is exit 4 resuming connector after 150 s', async () => {
    const setup = await connectorStore();
    setup.fake.on('POST /v1/admin/connector/preview', () => json({ error: 'sync_running' }, 409));
    const outcome = await setup.run({ command: 'connector' }, ['connector']);
    expect(outcome.output).toMatchObject({
      retryAfterSeconds: 150,
      resume: 'npx -y @elisym/cli@latest askr connector',
    });
  });
});

describe('the upgrade block follows what the server says of billing', () => {
  const MESSAGE_US = 'Message us with your Store ID';
  const CHECKOUT = 'askr plan <starter|growth|pro|scale> [--yearly]';
  const NO_PLAN = {
    enabled: true,
    plan: null,
    interval: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    manageable: false,
    checkoutAvailable: true,
  };
  const PAYING = {
    ...NO_PLAN,
    plan: 'growth',
    interval: 'month',
    status: 'active',
    currentPeriodEnd: 1_900_000_000,
    manageable: true,
    checkoutAvailable: false,
  };

  function howToOf(output: Record<string, unknown>): string {
    return String(Reflect.get(Object(output.upgrade), 'howTo'));
  }

  function adminOf(output: Record<string, unknown>): unknown {
    return Reflect.get(Object(output.upgrade), 'admin');
  }

  /** The admin URL of the harness's own server, never the production one. */
  async function adminUrlOf(setup: Harness): Promise<string> {
    const url = String(
      (await setup.run({ command: 'status', options: {} }, ['status'])).output.adminUrl,
    );
    expect(url).not.toBe('https://app.askr.elisym.network/admin/');
    return url;
  }

  it('init on a store awaiting its plan: message us without billing, askr plan with it', async () => {
    const off = await harness();
    const before = await off.run(initInvocation(), INIT_ARGS);
    expect(String(before.output.next)).toContain('message us');
    expect(howToOf(before.output)).toBe(MESSAGE_US);

    const on = await harness();
    on.fake.billing = NO_PLAN;
    const after = await on.run(initInvocation(), INIT_ARGS);
    expect(String(after.output.next)).toContain(CHECKOUT);
    expect(String(after.output.next)).not.toContain('message us');
    expect(howToOf(after.output)).toContain(CHECKOUT);
    expect(after.output.upgrade).toMatchObject({ contact: 'https://askr.elisym.network/contact' });
  });

  it('status: checkout when the store can buy, Manage billing when it pays, else message us', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const status = async (): Promise<Record<string, unknown>> =>
      (await setup.run({ command: 'status', options: {} }, ['status'])).output;

    expect(howToOf(await status())).toBe(MESSAGE_US);
    setup.fake.billing = { ...NO_PLAN, enabled: false, checkoutAvailable: false };
    expect(howToOf(await status())).toBe(MESSAGE_US);
    setup.fake.billing = NO_PLAN;
    expect(howToOf(await status())).toContain(CHECKOUT);
    // An ended plan leaves a Stripe customer: the portal cannot start a new plan, checkout can.
    setup.fake.billing = { ...NO_PLAN, manageable: true };
    const ended = await status();
    expect(howToOf(ended)).toContain(CHECKOUT);
    expect(adminOf(ended)).toBeUndefined();

    setup.fake.status = 'active';
    setup.fake.tier = { ...FREE_TIER, name: 'growth' };
    setup.fake.billing = PAYING;
    const paying = await status();
    expect(howToOf(paying)).toContain('Manage billing');
    expect(adminOf(paying)).toBe(paying.adminUrl);
    expect(paying.adminUrl).not.toBe('https://app.askr.elisym.network/admin/');
    setup.fake.billing = { ...PAYING, operatorManaged: true };
    expect(howToOf(await status())).toBe(MESSAGE_US);
    setup.fake.billing = { ...PAYING, manageable: false };
    expect(howToOf(await status())).toBe(MESSAGE_US);
  });

  it('a write on a pending store with billing carries the checkout upgrade', async () => {
    const setup = await harness();
    setup.fake.billing = NO_PLAN;
    await setup.run(initInvocation(), INIT_ARGS);
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output).toMatchObject({ error: { code: 'inactive' } });
    expect(howToOf(outcome.output)).toContain(CHECKOUT);
  });

  it('a write on a pending store that still pays names the admin of its own server', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.billing = PAYING;
    const admin = await adminUrlOf(setup);
    const file = await writeJson([product('a')]);
    const outcome = await setup.run({ command: 'products', options: { file } }, ['products']);
    expect(outcome.output).toMatchObject({ error: { code: 'inactive' } });
    expect(howToOf(outcome.output)).toContain('Manage billing');
    expect(adminOf(outcome.output)).toBe(admin);
  });

  it('too_many_products from products and from the connector follows billing too', async () => {
    const products = await activeStore();
    products.fake.billing = PAYING;
    products.fake.tier = { ...FREE_TIER, maxProducts: 1 };
    const file = await writeJson([product('a'), product('b')]);
    const tooMany = await products.run({ command: 'products', options: { file } }, ['products']);
    expect(tooMany.output).toMatchObject({ error: { code: 'too_many_products' } });
    expect(howToOf(tooMany.output)).toContain('Manage billing');
    expect(adminOf(tooMany.output)).toBe(await adminUrlOf(products));

    const connector = await activeStore({
      source: 'connector',
      platform: 'shopify',
      shopUrl: ORIGIN,
    });
    connector.fake.billing = NO_PLAN;
    connector.fake.runResult = {
      status: 'error',
      message: 'big',
      reason: 'too_many_products',
      count: 300,
      max: 100,
    };
    const big = await connector.run({ command: 'connector' }, ['connector']);
    expect(big.output).toMatchObject({ error: { code: 'too_many_products' } });
    expect(howToOf(big.output)).toContain(CHECKOUT);

    const previewed = await activeStore({
      source: 'connector',
      platform: 'shopify',
      shopUrl: ORIGIN,
    });
    previewed.fake.billing = NO_PLAN;
    previewed.fake.previewResult = {
      status: 'error',
      message: 'big',
      reason: 'too_many_products',
      count: 300,
      max: 100,
    };
    const preview = await previewed.run({ command: 'connector' }, ['connector']);
    expect(preview.output).toMatchObject({ error: { code: 'too_many_products' } });
    expect(howToOf(preview.output)).toContain(CHECKOUT);
    expect(previewed.fake.routeCalls('POST /v1/admin/connector/enable')).toHaveLength(0);
  });

  it('a spent monthly budget points at the upgrade block, which follows billing', async () => {
    const setup = await activeStore();
    setup.fake.billing = NO_PLAN;
    setup.fake.on('POST /v1/session', () => json({ unavailable: true, reason: 'budget' }, 503));
    const spent = await setup.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(spent.output).toMatchObject({ error: { code: 'budget' } });
    const hint = String(Reflect.get(Object(spent.output.error), 'hint'));
    expect(hint).toContain('upgrade.howTo');
    expect(hint).not.toContain('message us');
    expect(howToOf(spent.output)).toContain(CHECKOUT);
  });
});

describe('askr status', () => {
  it('no key: store null; a key without a store: store null with the init hint', async () => {
    const setup = await harness();
    const none = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(none.output).toEqual({ ok: true, profile: 'default', store: null });
    setup.fake.on('POST /v1/admin/store', () => json({ error: 'unavailable' }, 503));
    setup.fake.on('GET /v1/admin/store', () => json({ error: 'no_store' }, 404));
    await setup.run(initInvocation(), INIT_ARGS);
    const keyOnly = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(keyOnly).toMatchObject({ exitCode: 0, output: { store: null } });
    expect(String(keyOnly.output.hint)).toContain('askr init creates it');
  });

  it('prints the billing the server reports, null from a server without it, and the paid hint', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const before = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(before.output.billing).toBeNull();
    expect(String(before.output.hint)).toContain('message us with your Store ID for a paid plan');
    setup.fake.billing = {
      enabled: true,
      plan: null,
      interval: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      manageable: false,
      checkoutAvailable: true,
    };
    const pending = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(String(pending.output.hint)).toContain(
      'askr plan <starter|growth|pro|scale> [--yearly]',
    );
    setup.fake.billing = {
      enabled: true,
      plan: 'pro',
      interval: 'year',
      status: 'past_due',
      currentPeriodEnd: 1_900_000_000,
      cancelAtPeriodEnd: false,
      manageable: true,
      checkoutAvailable: false,
    };
    setup.fake.status = 'active';
    setup.fake.tier = { ...FREE_TIER, name: 'pro' };
    const paid = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(paid.output.billing).toEqual({
      enabled: true,
      plan: 'pro',
      interval: 'year',
      status: 'past_due',
      currentPeriodEnd: 1_900_000_000,
      cancelAtPeriodEnd: false,
      checkoutAvailable: false,
    });
  });

  it('moved is exit 3 moved_store', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.on('GET /v1/admin/store', () => json({ error: 'moved' }, 409));
    const outcome = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(outcome).toMatchObject({ exitCode: 3, output: { error: { code: 'moved_store' } } });
  });

  it('awaitingPlan is true only for pending without a tier', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const pending = await setup.run({ command: 'status', options: { probe: true } }, ['status']);
    expect(pending.output).toMatchObject({ awaitingPlan: true, status: 'pending' });
    expect(pending.output.probe).toEqual({
      result: 'skipped',
      reason: 'the store is pending: the chat is not served until its plan is active',
    });
    setup.fake.tier = FREE_TIER;
    const managed = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(managed.output).toMatchObject({ awaitingPlan: false });
    expect(String(managed.output.hint)).toContain('message us');
    setup.fake.status = 'active';
    const active = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(active.output).toMatchObject({ awaitingPlan: false });
    expect(active.output.hint).toBeUndefined();
  });

  it('plain status (no --probe) prints no probe and opens no chat session, pending or active', async () => {
    const pending = await harness();
    await pending.run(initInvocation(), INIT_ARGS);
    const unprobed = await pending.run({ command: 'status', options: {} }, ['status']);
    expect(unprobed.output).toMatchObject({ status: 'pending' });
    expect(unprobed.output).not.toHaveProperty('probe');
    const active = await activeStore();
    const outcome = await active.run({ command: 'status', options: {} }, ['status']);
    expect(outcome).toMatchObject({ exitCode: 0, output: { status: 'active' } });
    expect(outcome.output).not.toHaveProperty('probe');
    expect(active.fake.routeCalls('POST /v1/session')).toEqual([]);
  });

  it('counts listed and visible products, and reads the connector run', async () => {
    const setup = await activeStore();
    setup.fake.seedProducts([product('a'), product('b', { visibility: 'hidden' })]);
    const outcome = await setup.run({ command: 'status', options: { probe: true } }, ['status']);
    expect(outcome.output).toMatchObject({
      products: { listed: 2, visible: 1 },
      probe: { origin: ORIGIN, result: 'ok' },
      usage: { conversations: 2, todaySpentUsd: '0.1', monthSpentUsd: '1.5' },
      connector: null,
    });
  });

  it('probe: not_ready and inactive-while-active retried; final results mapped', async () => {
    const setup = await activeStore();
    setup.fake.probeAnswers = [
      json({ error: 'not_ready' }, 503),
      json({ unavailable: true, reason: 'inactive' }, 503),
      json({ error: 'forbidden' }, 403),
    ];
    const retried = await setup.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(retried.output.probe).toEqual({ origin: ORIGIN, result: 'ok' });

    setup.fake.on('POST /v1/session', () => json({ error: 'forbidden' }, 403));
    const forbidden = await setup.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(forbidden).toMatchObject({ exitCode: 3, output: { error: { code: 'forbidden' } } });

    const budget = await activeStore();
    budget.fake.on('POST /v1/session', () => json({ unavailable: true, reason: 'budget' }, 503));
    const spent = await budget.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(spent).toMatchObject({
      exitCode: 5,
      output: {
        ok: false,
        error: { code: 'budget' },
        upgrade: {},
        // A failed probe still prints the whole status.
        status: 'active',
        products: { listed: 0, visible: 0 },
        usage: { monthSpentUsd: '1.5' },
        probe: { origin: ORIGIN, result: 'budget' },
      },
    });
    const budgetHint = String((spent.output.error as { hint?: string }).hint);
    expect(budgetHint).toContain("plan's monthly limit");
    expect(budgetHint).toContain('upgrade');
    expect(budgetHint).not.toContain('used up');

    const limited = await activeStore();
    limited.fake.on('POST /v1/session', () => json({ error: 'rate_limited' }, 429));
    const slow = await limited.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(slow).toMatchObject({
      exitCode: 4,
      output: { retryAfterSeconds: 60, resume: 'npx -y @elisym/cli@latest askr status --probe' },
    });

    const notReady = await activeStore();
    notReady.fake.on('POST /v1/session', () => json({ error: 'not_ready' }, 503));
    const started = Date.now();
    const late = await notReady.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(Date.now() - started).toBeLessThanOrEqual(85_000);
    expect(late).toMatchObject({ exitCode: 4, output: { error: { code: 'not_ready' } } });

    const movedAway = await activeStore();
    movedAway.fake.on('POST /v1/session', () =>
      json({ unavailable: true, reason: 'moved', moved: 'f'.repeat(64) }, 410),
    );
    const moved = await movedAway.run({ command: 'status', options: { probe: true } }, [
      'status',
      '--probe',
    ]);
    expect(moved).toMatchObject({
      exitCode: 3,
      output: { error: { code: 'moved_store' }, status: 'active', probe: { result: 'moved' } },
    });

    const suspended = await activeStore();
    suspended.fake.status = 'suspended';
    suspended.fake.on('POST /v1/session', () =>
      json({ unavailable: true, reason: 'inactive' }, 503),
    );
    const inactive = await suspended.run({ command: 'status', options: { probe: true } }, [
      'status',
    ]);
    expect(inactive).toMatchObject({ exitCode: 3, output: { error: { code: 'inactive' } } });
  });

  it('a relay read that never answers is closed at the deadline: exit 4', async () => {
    const setup = await activeStore();
    let closed = false;
    setup.deps.connectRelay = async () => ({
      query: () => new Promise(() => undefined),
      close: () => {
        closed = true;
      },
    });
    const started = Date.now();
    const outcome = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(Date.now() - started).toBeLessThanOrEqual(85_000);
    expect(outcome).toMatchObject({
      exitCode: 4,
      output: { resume: 'npx -y @elisym/cli@latest askr status' },
    });
    expect(closed).toBe(true);
  });
});
