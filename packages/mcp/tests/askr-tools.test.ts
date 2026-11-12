import {
  type SyncRelayClient,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildConfigEvent,
} from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { teardownRegistry } from '../src/server.js';
import { buildAgentInstance, scrubAgent } from '../src/tools/agent.js';
import { createAskrTools } from '../src/tools/askr.js';
import type { ToolResult } from '../src/tools/types.js';

const NOW = Math.floor(Date.now() / 1000);

class MemoryRelay implements SyncRelayClient {
  readonly events: NostrEvent[] = [];
  readonly published: NostrEvent[] = [];
  closed = 0;
  async query(_relays: readonly string[], filter: Filter): Promise<NostrEvent[]> {
    return this.events.filter((event) => matchFilter(filter, event));
  }
  async publish(_relays: readonly string[], event: NostrEvent): Promise<void> {
    this.published.push(event);
    this.events.push(event);
  }
  close(): void {
    this.closed += 1;
  }
}

interface World {
  ctx: AgentContext;
  relay: MemoryRelay;
  owner: Uint8Array;
  catalog: Uint8Array;
  agent: AgentInstance;
}

function world(
  options: {
    authorize?: boolean;
    config?: 'this-key' | 'other-key' | 'none';
    key?: boolean;
    otherPolicyKey?: boolean;
    configAt?: number;
  } = {},
): World {
  const owner = generateSecretKey();
  const catalog = generateSecretKey();
  const relay = new MemoryRelay();
  const ownerPubkey = getPublicKey(owner);
  if (options.authorize !== false) {
    relay.events.push(
      finalizeEvent(
        buildCatalogAuth({ key: getPublicKey(catalog), mode: 'self-host', createdAt: NOW - 100 }),
        owner,
      ),
    );
  }
  const configFor = options.config ?? 'this-key';
  if (configFor !== 'none') {
    const named =
      configFor === 'this-key' ? getPublicKey(catalog) : getPublicKey(generateSecretKey());
    relay.events.push(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: getPublicKey(generateSecretKey()),
            origins: ['https://shop.example.com'],
            name: 'Example Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: named,
            ...(options.otherPolicyKey ? { policyKey: getPublicKey(generateSecretKey()) } : {}),
            private: {},
            createdAt: options.configAt ?? NOW - 50,
          },
          owner,
        ),
        owner,
      ),
    );
  }
  const agent = {
    client: {} as never,
    identity: {} as never,
    name: 'merchant',
    network: 'devnet',
    security: {},
    ...(options.key === false ? {} : { askr: { secretKey: catalog, store: ownerPubkey } }),
  } as AgentInstance;
  const ctx = new AgentContext();
  ctx.register(agent);
  return { ctx, relay, owner, catalog, agent };
}

function tools(relay: MemoryRelay) {
  const list = createAskrTools({ connect: async () => relay });
  return (name: string) => {
    const found = list.find((tool) => tool.name === name);
    if (found === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return found;
  };
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('\n');
}

const SOCKS = { d: 'socks', title: 'Wool socks', price: { amount: '12', currency: 'USD' } };
const HAT = { d: 'hat', title: 'Hat', price: { amount: '20', currency: 'USD' } };

describe('Askr catalog tools', () => {
  it('upserts products, leaves the others, and reports the diff', async () => {
    const run = world();
    const tool = tools(run.relay);
    const first = await tool('askr_upsert_products').handler(run.ctx, {
      products: [SOCKS, HAT],
      dry_run: false,
    });
    expect(first.isError).toBeUndefined();
    expect(JSON.parse(text(first))).toMatchObject({ created: ['socks', 'hat'], dry_run: false });
    expect(JSON.parse(text(first))).not.toHaveProperty('warning');
    const second = await tool('askr_upsert_products').handler(run.ctx, {
      products: [{ ...SOCKS, price: { amount: '13', currency: 'USD' } }],
      dry_run: false,
    });
    expect(JSON.parse(text(second))).toMatchObject({ updated: ['socks'], hidden: [] });
    expect(run.relay.published.every((event) => event.pubkey === getPublicKey(run.catalog))).toBe(
      true,
    );
    expect(run.relay.closed).toBe(2);
  });

  it('hides by id and previews a replace without publishing', async () => {
    const run = world();
    const tool = tools(run.relay);
    await tool('askr_upsert_products').handler(run.ctx, { products: [SOCKS, HAT], dry_run: false });
    const published = run.relay.published.length;
    const preview = await tool('askr_preview_diff').handler(run.ctx, {
      products: [SOCKS],
      replace: true,
    });
    expect(JSON.parse(text(preview))).toMatchObject({
      dry_run: true,
      hidden: ['hat'],
      unchanged: ['socks'],
    });
    const upsertPreview = await tool('askr_preview_diff').handler(run.ctx, {
      products: [SOCKS],
      replace: false,
    });
    expect(JSON.parse(text(upsertPreview))).toMatchObject({ hidden: [], unchanged: ['socks'] });
    expect(run.relay.published).toHaveLength(published);
    const hidden = await tool('askr_hide_products').handler(run.ctx, {
      ids: ['hat'],
      dry_run: false,
    });
    expect(JSON.parse(text(hidden))).toMatchObject({ hidden: ['hat'] });
    expect(run.relay.published.slice(published).map((event) => event.kind)).toEqual([30402, 5]);
  });

  it('sets a policy signed by the catalog key', async () => {
    const run = world();
    const result = await tools(run.relay)('askr_set_policy').handler(run.ctx, {
      slug: 'returns',
      title: 'Returns',
      body: '30 days.',
    });
    expect(JSON.parse(text(result))).toMatchObject({ slug: 'returns' });
    expect(run.relay.published.at(-1)?.kind).toBe(30495);
    expect(run.relay.published.at(-1)?.pubkey).toBe(getPublicKey(run.catalog));
  });

  it('warns when the store config reads from another key, or there is no config', async () => {
    const other = world({ config: 'other-key' });
    const result = await tools(other.relay)('askr_upsert_products').handler(other.ctx, {
      products: [SOCKS],
      dry_run: false,
    });
    expect(JSON.parse(text(result)).warning).toMatch(/another key/);
    const policy = await tools(other.relay)('askr_set_policy').handler(other.ctx, {
      slug: 'returns',
      title: 'Returns',
      body: '30 days.',
    });
    expect(JSON.parse(text(policy)).warning).toMatch(/policies from another key/);
    const none = world({ config: 'none' });
    const preview = await tools(none.relay)('askr_preview_diff').handler(none.ctx, {
      products: [SOCKS],
      replace: false,
    });
    expect(JSON.parse(text(preview)).warning).toMatch(/no published config/);
  });

  it('refuses without a key, and names the key the owner must authorize', async () => {
    const keyless = world({ key: false });
    const missing = await tools(keyless.relay)('askr_upsert_products').handler(keyless.ctx, {
      products: [SOCKS],
      dry_run: false,
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/askr-key/);

    const unauthorized = world({ authorize: false });
    const refused = await tools(unauthorized.relay)('askr_upsert_products').handler(
      unauthorized.ctx,
      { products: [SOCKS], dry_run: false },
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/has not authorized this agent's catalog key \(npub1/);
    expect(unauthorized.relay.published).toEqual([]);
    expect(unauthorized.relay.closed).toBe(1);
  });

  it('never touches another key, even one listing the same d', async () => {
    const run = world();
    const stranger = generateSecretKey();
    run.relay.events.push(
      finalizeEvent(buildCatalogItemEvent({ ...SOCKS, createdAt: NOW - 10 }), stranger),
    );
    const hidden = await tools(run.relay)('askr_hide_products').handler(run.ctx, {
      ids: ['socks'],
      dry_run: false,
    });
    expect(JSON.parse(text(hidden))).toMatchObject({ hidden: [] });
    expect(run.relay.published).toEqual([]);
  });

  it('a product input the protocol refuses is an error, not a publish', async () => {
    const run = world();
    const [tool] = createAskrTools({ connect: async () => run.relay }).filter(
      (candidate) => candidate.name === 'askr_upsert_products',
    );
    const parsed = tool?.schema.safeParse({
      products: [{ ...SOCKS, price: { amount: '12.5.1', currency: 'USD' } }],
    });
    expect(parsed?.success).toBe(false);
    const tooMany = tool?.schema.safeParse({
      products: Array.from({ length: 201 }, (_unused, index) => ({ ...SOCKS, d: `p${index}` })),
    });
    expect(tooMany?.success).toBe(false);
  });

  it('loads the catalog key with the agent and zeroes it on teardown', async () => {
    const secret = generateSecretKey();
    const store = getPublicKey(generateSecretKey());
    const instance = await buildAgentInstance('merchant', {
      nostrSecretKey: bytesToHex(generateSecretKey()),
      askrCatalogSecretKey: bytesToHex(secret),
      askrStore: store,
      network: 'devnet',
    });
    expect(instance.askr?.store).toBe(store);
    const loaded = instance.askr?.secretKey;
    expect(loaded && getPublicKey(loaded)).toBe(getPublicKey(secret));
    const ctx = new AgentContext();
    ctx.register(instance);
    await scrubAgent(ctx, instance);
    expect(loaded?.every((byte) => byte === 0)).toBe(true);

    const malformed = await buildAgentInstance('merchant', {
      nostrSecretKey: bytesToHex(generateSecretKey()),
      askrCatalogSecretKey: 'not-hex',
      askrStore: store,
      network: 'devnet',
    });
    expect(malformed.askr).toBeUndefined();
    const storeless = await buildAgentInstance('merchant', {
      nostrSecretKey: bytesToHex(generateSecretKey()),
      askrCatalogSecretKey: bytesToHex(secret),
      network: 'devnet',
    });
    expect(storeless.askr).toBeUndefined();
    for (const agent of [malformed, storeless]) {
      agent.client.close();
    }
  });

  it('a dry run publishes nothing, for an upsert and a hide alike', async () => {
    const run = world();
    const tool = tools(run.relay);
    await tool('askr_upsert_products').handler(run.ctx, { products: [SOCKS], dry_run: false });
    const published = run.relay.published.length;
    const upsert = await tool('askr_upsert_products').handler(run.ctx, {
      products: [HAT, { ...SOCKS, price: { amount: '99', currency: 'USD' } }],
      dry_run: true,
    });
    expect(JSON.parse(text(upsert))).toMatchObject({
      dry_run: true,
      created: ['hat'],
      updated: ['socks'],
    });
    const hide = await tool('askr_hide_products').handler(run.ctx, {
      ids: ['socks'],
      dry_run: true,
    });
    expect(JSON.parse(text(hide))).toMatchObject({ dry_run: true, hidden: ['socks'] });
    expect(run.relay.published).toHaveLength(published);
  });

  it("warns about policies by the config's policy key, not its catalog key", async () => {
    const run = world({ otherPolicyKey: true });
    const tool = tools(run.relay);
    const products = await tool('askr_upsert_products').handler(run.ctx, {
      products: [SOCKS],
      dry_run: false,
    });
    expect(JSON.parse(text(products))).not.toHaveProperty('warning');
    const policy = await tool('askr_set_policy').handler(run.ctx, {
      slug: 'returns',
      title: 'Returns',
      body: '30 days.',
    });
    expect(JSON.parse(text(policy)).warning).toMatch(/policies from another key/);
  });

  it('a config dated in the future does not count yet', async () => {
    const run = world({ configAt: NOW + 3_600 });
    const result = await tools(run.relay)('askr_upsert_products').handler(run.ctx, {
      products: [SOCKS],
      dry_run: false,
    });
    expect(JSON.parse(text(result)).warning).toMatch(/no published config/);
  });

  it('a config that cannot be read after a successful write is a warning, not a failure', async () => {
    const run = world();
    let reads = 0;
    const query = run.relay.query.bind(run.relay);
    run.relay.query = async (relays, filter) => {
      if (filter.kinds?.includes(30496)) {
        reads += 1;
        throw new Error('relay hiccup');
      }
      return query(relays, filter);
    };
    const result = await tools(run.relay)('askr_upsert_products').handler(run.ctx, {
      products: [SOCKS],
      dry_run: false,
    });
    expect(result.isError).toBeUndefined();
    expect(reads).toBe(1);
    expect(JSON.parse(text(result))).toMatchObject({ created: ['socks'] });
    expect(JSON.parse(text(result)).warning).toMatch(/Could not read the store config/);
  });

  it('server teardown zeroes the catalog key', async () => {
    const run = world();
    const key = run.agent.askr?.secretKey;
    run.agent.client = { close: () => undefined } as never;
    run.agent.identity = { scrub: () => undefined } as never;
    await teardownRegistry(run.ctx);
    expect(key?.every((byte) => byte === 0)).toBe(true);
  });
});
