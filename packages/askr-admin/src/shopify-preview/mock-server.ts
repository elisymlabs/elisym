import type { StoreConfig, StorePrivateConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey, generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import type { SettingsInput, ShopifyView } from '../shopify/types';

/** The shop the preview pretends to be opened for. */
export const PREVIEW_SHOP = 'preview-tea.myshopify.com';
const PRIMARY = 'https://preview-tea.example';

/** What the preview can make the fake server do next, from its control bar. */
export interface PreviewScenario {
  /** The owner manages the store with the owner key: settings read only, D writes refused. */
  ownerManages: boolean;
  /** The next `finish` answers as if another staff member's setup replaced this one. */
  replaceNextFinish: boolean;
  /** The store is paused by the operator. */
  suspended: boolean;
}

interface State {
  onboarded: boolean;
  owner: string;
  status: 'pending' | 'active' | 'suspended';
  tier: string | null;
  lastRunAt: number | null;
  config: StoreConfig;
  private: StorePrivateConfig;
}

function initialConfig(): StoreConfig {
  return {
    owner: '',
    signer: '',
    assistant: getPublicKey(generateSecretKey()),
    origins: [PRIMARY, `https://${PREVIEW_SHOP}`],
    linkOrigins: [],
    name: 'Preview Tea House',
    language: 'en',
    currency: 'EUR',
    source: { kind: 'connector', platform: 'shopify', shopUrl: PRIMARY },
    catalogKey: getPublicKey(generateSecretKey()),
    policyKey: '',
    privateContent: '',
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The Askr server's `/v1/shopify/` routes in memory, for looking at the embedded admin without
 * Shopify or a server (`bun run dev:shopify`). It answers like the server does for the happy
 * paths and the refusals the control bar asks for; it checks the onboarding signatures, nothing
 * more. Never part of a build.
 */
export function createMockServer(scenario: PreviewScenario): {
  fetch: typeof fetch;
  reset: () => void;
} {
  let state: State = fresh();
  const catalogKey = getPublicKey(generateSecretKey());
  const delegate = getPublicKey(generateSecretKey());

  function fresh(): State {
    return {
      onboarded: false,
      owner: '',
      status: 'pending',
      tier: null,
      lastRunAt: null,
      config: initialConfig(),
      private: { voice: '', instructions: '', notes: '' },
    };
  }

  const status = () => (scenario.suspended && state.onboarded ? 'suspended' : state.status);

  const view = (): ShopifyView => ({
    shop: PREVIEW_SHOP,
    onboarded: state.onboarded,
    store: state.onboarded
      ? {
          owner: state.owner,
          npub: 'npub1preview',
          onboarding: false,
          status: status(),
          tier: state.tier,
          connector: {
            owner: state.owner,
            platform: 'shopify',
            url: PRIMARY,
            currency: 'EUR',
            importPolicies: true,
            enabled: state.status === 'active',
            lastStatus: state.lastRunAt === null ? null : { status: 'ok' },
            lastRunAt: state.lastRunAt,
            nextRunAt: null,
          },
          delegation: { active: true, inCharge: !scenario.ownerManages },
        }
      : null,
  });

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://preview');
    const method = init?.method ?? 'GET';
    const text = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    // A moment of latency, so busy states show.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /v1/shopify/time') {
      return reply({ now: Math.floor(Date.now() / 1000) });
    }
    if (route === 'GET /v1/shopify/store') {
      return reply(view());
    }
    if (route === 'POST /v1/shopify/onboard/begin') {
      const headers = new Headers(init?.headers);
      if (!(headers.get('x-askr-owner-authorization') ?? '').startsWith('Nostr ')) {
        return reply({ error: 'unauthorized', reason: 'missing' }, 401);
      }
      return reply({ catalogKey, delegate, now: Math.floor(Date.now() / 1000) });
    }
    if (route === 'POST /v1/shopify/onboard/finish') {
      if (scenario.replaceNextFinish) {
        scenario.replaceNextFinish = false;
        return reply({ error: 'onboarding_replaced' }, 409);
      }
      const events = (body as { events?: NostrEvent[] } | undefined)?.events ?? [];
      if (events.length !== 2 || !events.every((event) => verifyEvent(event))) {
        return reply({ error: 'bad_events', reason: 'signature' }, 400);
      }
      state.onboarded = true;
      state.owner = events[0]?.pubkey ?? '';
      state.config = { ...state.config, owner: state.owner, signer: delegate };
      return reply(view());
    }
    if (route === 'POST /v1/shopify/plan/free') {
      if (status() === 'suspended') {
        return reply({ error: 'not_pending' }, 409);
      }
      state.status = 'active';
      state.tier = 'free';
      state.lastRunAt = Date.now();
      return reply({ ...view(), activation: 'activated' });
    }
    if (route === 'GET /v1/shopify/settings') {
      return reply({
        config: state.config,
        private: state.private,
        inCharge: !scenario.ownerManages,
      });
    }
    if (route === 'PUT /v1/shopify/settings') {
      if (scenario.ownerManages) {
        return reply({ error: 'owner_managed' }, 409);
      }
      const input = body as SettingsInput;
      const own = [PRIMARY, `https://${PREVIEW_SHOP}`];
      const origins = [...new Set([...own, ...input.origins])];
      if (origins.length > 20) {
        return reply({ error: 'too_many_origins', max: 18 }, 400);
      }
      if (origins.some((origin) => !/^https:\/\/[^/]+$/u.test(origin))) {
        return reply({ error: 'bad_settings' }, 400);
      }
      state.config = {
        ...state.config,
        ...input,
        origins,
        createdAt: Math.floor(Date.now() / 1000),
      };
      state.private = input.private;
      return reply({ saved: true });
    }
    return reply({ error: 'not_found' }, 404);
  };
  return {
    fetch: fetcher,
    reset: () => {
      state = fresh();
    },
  };
}
