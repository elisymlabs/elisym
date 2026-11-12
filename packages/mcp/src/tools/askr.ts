/**
 * Askr catalog tools (7.2): a merchant's agent keeps an Askr store's products
 * and policies, signing with the agent's catalog key K (`elisym askr-key`).
 * Every write runs the same check as `syncCatalog`: the store owner must have
 * authorized K. Only K's own listings are ever touched, and no tool takes a
 * secret key as an argument.
 */
import {
  ASKR_RELAYS,
  CONFIG_D_TAG,
  CatalogItemInputSchema,
  KIND_CONFIG,
  type SyncDiff,
  type SyncRelayClient,
  connectSyncClient,
  parseConfig,
  setPolicy,
  syncCatalog,
} from '@elisym/askr';
import { newestSigned, nowSecs } from '@elisym/commerce';
import { nip19 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { z } from 'zod';
import type { AgentInstance } from '../context.js';
import type { ToolDefinition } from './types.js';
import { defineTool, errorResult, textResult } from './types.js';

/**
 * Products per call. Publishing is paced at 10 events a second, so a call of
 * 200 updates takes about 20 s, and hiding 200 (two events each) about 40 s:
 * split larger changes into several calls.
 */
const MAX_PRODUCTS_PER_CALL = 200;

/** `syncCatalog`'s refusal when the owner has not authorized the key (exactly; a relay's own refusal reads otherwise). */
const NOT_AUTHORIZED = 'This key is not authorized as a catalog key by the store owner';

const NO_KEY =
  'This agent has no Askr catalog key. Run `elisym askr-key <agent> --store <owner npub>` in a ' +
  'terminal, authorize the printed key in the Askr admin, then restart the MCP server so it ' +
  'loads the key.';

/**
 * A product as the tools take it: the protocol's input without `createdAt`,
 * which the sync always sets itself. The whole input schema still checks each
 * product inside `syncCatalog`.
 */
const ProductSchema = CatalogItemInputSchema.innerType().omit({ createdAt: true });

const ProductsSchema = z
  .array(ProductSchema)
  .min(1)
  .max(MAX_PRODUCTS_PER_CALL)
  .describe(
    `Products, at most ${MAX_PRODUCTS_PER_CALL} per call. Each: d (the product id, unique in the ` +
      'store), title, price {amount as a decimal string, currency}, and optionally summary, ' +
      'description, images (https), url (the product page, https, on one of the store origins or ' +
      'link origins, else not shown), topics, attrs, options, ' +
      'variants, visibility.',
  );

const UpsertSchema = z.object({
  products: ProductsSchema,
  dry_run: z.boolean().default(false).describe('Report what would change, publish nothing.'),
});

const HideSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_PRODUCTS_PER_CALL)
    .describe('The `d` ids of products to hide from the store.'),
  dry_run: z.boolean().default(false).describe('Report what would change, publish nothing.'),
});

const PreviewSchema = z.object({
  products: ProductsSchema,
  replace: z
    .boolean()
    .default(false)
    .describe(
      'true: `products` is the whole catalog, and every listed product missing from it would be ' +
        `hidden (a call takes at most ${MAX_PRODUCTS_PER_CALL} products, so a larger catalog ` +
        'cannot be previewed as a replace). false: only these products are compared.',
    ),
});

const PolicySchema = z.object({
  slug: z.string().min(1).describe('Policy id, such as "returns" or "shipping".'),
  title: z.string().min(1).describe('Policy title shown to visitors.'),
  body: z.string().min(1).describe('Policy text in markdown.'),
});

export interface AskrToolDeps {
  /** A relay client for one call; closed after it. */
  connect: () => Promise<SyncRelayClient & { close: () => void }>;
}

const DEFAULT_DEPS: AskrToolDeps = {
  connect: () => {
    const [relay] = ASKR_RELAYS;
    if (relay === undefined) {
      throw new Error('No Askr relay configured');
    }
    return connectSyncClient(relay);
  },
};

function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why visitors would not see what this key writes, or undefined when they
 * would: the store's config (30496, signed by the owner) names the key its
 * products (or policies) are read from.
 */
async function configWarning(
  client: SyncRelayClient,
  store: string,
  key: string,
  role: 'products' | 'policies',
): Promise<string | undefined> {
  // Runs after the write succeeded: a failed read is a warning, never the call's result.
  let events: Awaited<ReturnType<SyncRelayClient['query']>>;
  try {
    events = await client.query(ASKR_RELAYS, {
      kinds: [KIND_CONFIG],
      authors: [store],
      '#d': [CONFIG_D_TAG],
    });
  } catch {
    return 'Could not read the store config to check that visitors will see this.';
  }
  const newest = newestSigned(events, KIND_CONFIG, store, nowSecs(), CONFIG_D_TAG);
  const config = newest === undefined ? undefined : parseConfig(newest);
  if (config === undefined) {
    return 'The store has no published config yet: visitors see nothing until the owner finishes onboarding in the Askr admin.';
  }
  const named = role === 'products' ? config.catalogKey : config.policyKey;
  if (named !== key) {
    return `The store config reads its ${role} from another key: visitors will not see these ${role} until the owner names this catalog key as the store's ${role === 'products' ? 'product source' : 'policy key'} in the Askr admin.`;
  }
  return undefined;
}

function diffText(
  store: string,
  diff: SyncDiff,
  dryRun: boolean,
  warning: string | undefined,
): string {
  return JSON.stringify(
    {
      store: nip19.npubEncode(store),
      dry_run: dryRun,
      created: diff.created,
      updated: diff.updated,
      hidden: diff.hidden,
      unchanged: diff.unchanged,
      ...(warning === undefined ? {} : { warning }),
    },
    null,
    2,
  );
}

function publicKeyOf(key: NonNullable<AgentInstance['askr']>): string {
  return getPublicKey(key.secretKey);
}

/** Run `work` with the agent's catalog key and a relay client, as one tool result. */
async function withCatalogKey(
  agent: AgentInstance,
  deps: AskrToolDeps,
  work: (key: NonNullable<AgentInstance['askr']>, client: SyncRelayClient) => Promise<string>,
) {
  const key = agent.askr;
  if (key === undefined) {
    return errorResult(NO_KEY);
  }
  let client: (SyncRelayClient & { close: () => void }) | undefined;
  try {
    client = await deps.connect();
    return textResult(await work(key, client));
  } catch (error) {
    const message = messageOf(error);
    if (message === NOT_AUTHORIZED) {
      return errorResult(
        `The store owner has not authorized this agent's catalog key (${nip19.npubEncode(publicKeyOf(key))}). ` +
          'Authorize it in the Askr admin, then retry.',
      );
    }
    return errorResult(`Askr: ${message}`);
  } finally {
    client?.close();
  }
}

export function createAskrTools(deps: AskrToolDeps = DEFAULT_DEPS): ToolDefinition[] {
  return [
    defineTool({
      name: 'askr_upsert_products',
      description:
        "Publish or update products in the Askr store this agent's catalog key writes. Only the " +
        'given products change; every other product stays as it is. Unchanged products are not ' +
        'republished. Returns the ids created, updated and unchanged.',
      schema: UpsertSchema,
      async handler(ctx, input) {
        ctx.toolRateLimiter.check();
        return withCatalogKey(ctx.active(), deps, async (key, client) => {
          const diff = await syncCatalog({
            signer: key.secretKey,
            store: key.store,
            items: input.products,
            mode: 'upsert',
            client,
            dryRun: input.dry_run,
          });
          const warning = await configWarning(client, key.store, publicKeyOf(key), 'products');
          return diffText(key.store, diff, input.dry_run, warning);
        });
      },
    }),
    defineTool({
      name: 'askr_hide_products',
      description:
        "Hide products from the Askr store this agent's catalog key writes, by their `d` ids. " +
        'An id that is not listed is skipped. Returns the ids hidden.',
      schema: HideSchema,
      async handler(ctx, input) {
        ctx.toolRateLimiter.check();
        return withCatalogKey(ctx.active(), deps, async (key, client) => {
          const diff = await syncCatalog({
            signer: key.secretKey,
            store: key.store,
            items: [],
            mode: 'upsert',
            hide: input.ids,
            client,
            dryRun: input.dry_run,
          });
          const warning = await configWarning(client, key.store, publicKeyOf(key), 'products');
          return diffText(key.store, diff, input.dry_run, warning);
        });
      },
    }),
    defineTool({
      name: 'askr_preview_diff',
      description:
        'Compare products with what the Askr store lists now and report what a sync would ' +
        'create, update and (with replace=true) hide. Publishes nothing.',
      schema: PreviewSchema,
      async handler(ctx, input) {
        ctx.toolRateLimiter.check();
        return withCatalogKey(ctx.active(), deps, async (key, client) => {
          const diff = await syncCatalog({
            signer: key.secretKey,
            store: key.store,
            items: input.products,
            mode: input.replace ? 'replace' : 'upsert',
            client,
            dryRun: true,
          });
          const warning = await configWarning(client, key.store, publicKeyOf(key), 'products');
          return diffText(key.store, diff, true, warning);
        });
      },
    }),
    defineTool({
      name: 'askr_set_policy',
      description:
        'Publish or replace a policy (returns, shipping, warranty, FAQ) in the Askr store, if this ' +
        "agent's catalog key is the store's policy key. The store's assistant quotes it to visitors.",
      schema: PolicySchema,
      async handler(ctx, input) {
        ctx.toolRateLimiter.check();
        return withCatalogKey(ctx.active(), deps, async (key, client) => {
          const event = await setPolicy({
            signer: key.secretKey,
            store: key.store,
            client,
            policy: input,
          });
          const warning = await configWarning(client, key.store, publicKeyOf(key), 'policies');
          return JSON.stringify(
            {
              store: nip19.npubEncode(key.store),
              slug: input.slug,
              event_id: event.id,
              ...(warning === undefined ? {} : { warning }),
            },
            null,
            2,
          );
        });
      },
    }),
  ];
}

export const askrTools: ToolDefinition[] = createAskrTools();
