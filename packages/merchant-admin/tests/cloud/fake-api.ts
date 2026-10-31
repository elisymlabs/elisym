/**
 * A typed stand-in for cloud-api in the admin's UI tests. One store state
 * feeds the owner view, `/status` and `/store` together (cloud-api derives
 * them from the same tenant and home, so they never disagree); every answer
 * is built in the shape cloud-api's own routes send; a request without a
 * Nostr auth event for its exact URL and method is refused as cloud-api
 * refuses it; every request is recorded. The client is checked against the
 * real API by contract tests and UI flows in the cloud repo.
 */
import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

export const TENANT_ID = 'aaaaaaaaaaaa';
export const STORE_PUBKEY = '1'.repeat(64);
const NOW = 1_900_000_000;
/** When a kept payout list was signed: well in the past, as any kept list is. */
const LIST_AT = 1_700_000_000;

type Body = Record<string, unknown>;

/** `GET /tiers` (served before the routes, unsigned). */
export function tiersAnswer(): Body {
  return {
    tiers: [
      {
        id: 'starter',
        name: 'Starter',
        price: '$29/mo',
        selfServe: true,
        limits: { products: 100, ordersPerMonth: 2000 },
        display: {},
        ownRpc: false,
        payable: { card: true, crypto: false },
      },
      {
        id: 'business',
        name: 'Business',
        price: '$99/mo',
        selfServe: true,
        limits: { products: 1000 },
        display: { ordersPerMonth: 'No cap' },
        ownRpc: true,
        payable: { card: true, crypto: false },
      },
    ],
  };
}

/** The digest cloud-api keeps of a product set (its `status.ts`). */
function digestOf(products: Readonly<Record<string, string>>): string {
  const entries = Object.entries(products).sort(([left], [right]) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
  const json = `{${entries.map(([name, text]) => `${JSON.stringify(name)}:${JSON.stringify(text)}`).join(',')}}`;
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

const RAILS = ['solana', 'tempo', 'ethereum', 'arbitrum', 'base'] as const;
const EVM: readonly string[] = ['ethereum', 'arbitrum', 'base'];

/** One store as cloud-api keeps it. */
export interface StoreState {
  paid: boolean;
  activated: boolean;
  name: string | undefined;
  rails: string[];
  payoutListId: string | undefined;
  products: Record<string, string>;
  runState: string;
  paidOrders: number;
  /** The nip05 the kept config names, if any. */
  nip05: string | undefined;
  /** The ledger's orders, as `GET /tenants/:id/orders` serves each. */
  orders: Record<string, unknown>[];
}

export function storeState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    paid: false,
    activated: false,
    name: undefined,
    rails: [],
    payoutListId: undefined,
    products: {},
    runState: 'not_launched',
    paidOrders: 0,
    nip05: undefined,
    orders: [],
    ...overrides,
  };
}

/** A store that is paid, named, paid to and stocked: every launch check holds. */
export function readyState(overrides: Partial<StoreState> = {}): StoreState {
  return storeState({
    paid: true,
    name: 'Shop',
    rails: ['solana'],
    payoutListId: 'f'.repeat(64),
    products: { course: '---\ntitle: "Course"\npriceUsd: "10"\n---\n\nA course.\n' },
    ...overrides,
  });
}

/** The kept choice as `GET /store` gives it (cloud-api's `storeChoiceFrom`): a rail off is absent. */
function choiceOf(state: StoreState): Body | null {
  if (state.name === undefined) {
    return null;
  }
  const evm = Object.fromEntries(
    EVM.filter((chain) => state.rails.includes(chain)).map((chain) => [chain, {}]),
  );
  return {
    name: state.name,
    ...(state.nip05 === undefined ? {} : { nip05: state.nip05 }),
    ...(state.rails.includes('solana') ? { solana: {} } : {}),
    ...(state.rails.includes('tempo') ? { tempo: {} } : {}),
    ...(Object.keys(evm).length === 0 ? {} : { evm }),
  };
}

/** One answer, or a function of the request's JSON body. */
export type Answer =
  | { status?: number; body: unknown }
  | ((body: unknown) => { status?: number; body: unknown });

/** A save waiting to be kept, as an edit cycle holds it. */
interface Queued {
  kind: 'store' | 'products' | 'owner-events';
  body: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

export class FakeStore {
  state: StoreState;
  /** Saves the store keeps at once (`true`), or only on `keep()`. */
  keepsAtOnce: boolean;
  readonly queued: Queued[] = [];

  constructor(state: StoreState, keepsAtOnce = true) {
    this.state = state;
    this.keepsAtOnce = keepsAtOnce;
  }

  /** Keeps every waiting save, as a cycle does at its start. */
  keep(): void {
    for (const save of this.queued.splice(0)) {
      const body = save.body;
      if (save.kind === 'store') {
        const evm = record(body.evm);
        const on = (value: unknown) => value !== null && value !== undefined;
        this.state.name = typeof body.name === 'string' ? body.name : this.state.name;
        this.state.rails = RAILS.filter((rail) =>
          EVM.includes(rail) ? on(evm[rail]) : on(body[rail]),
        );
      } else if (save.kind === 'products') {
        const products = record(body.products);
        this.state.products = Object.fromEntries(
          Object.entries(products).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      } else {
        const id = record(body.payoutList).id;
        this.state.payoutListId = typeof id === 'string' ? id : this.state.payoutListId;
      }
    }
  }

  view(): Body {
    const { state } = this;
    return {
      tenantId: TENANT_ID,
      tier: 'starter',
      tierName: 'Starter',
      network: 'mainnet',
      activated: state.activated,
      launch: 'console',
      ownerPubkey: '2'.repeat(64),
      storePubkey: state.paid ? STORE_PUBKEY : null,
      paidUntil: state.paid ? NOW : null,
      partner: null,
      payBy: null,
      rails: { card: { open: true }, crypto: { open: false, refusal: { code: 'rail_off' } } },
      sale: { withdrawnAt: null, ownerWithdrawn: false, held: false, stopped: false },
      exporting: false,
      exportStopped: null,
      export: null,
    };
  }

  status(): Body {
    const { state } = this;
    const productCount = Object.keys(state.products).length;
    let activation: string | null = state.paid ? null : 'not_paid';
    if (state.activated) {
      activation = 'already_activated';
    }
    return {
      tenantId: TENANT_ID,
      tier: 'starter',
      tierName: 'Starter',
      effectivePaidUntil: state.paid ? NOW : null,
      storePubkey: state.paid ? STORE_PUBKEY : null,
      productCount,
      pending: this.queued.length > 0,
      kept: {
        name: state.name ?? null,
        rails: state.rails,
        payoutList:
          state.payoutListId === undefined ? null : { id: state.payoutListId, createdAt: LIST_AT },
        productsDigest: digestOf(state.products),
      },
      ownerRefusal: null,
      resignInFlight: false,
      lastProblems: { store: null, 'owner-events': null, products: null },
      runState: state.activated ? state.runState : 'not_launched',
      gates: {
        activation,
        noCyclePending: this.queued.length === 0,
        homeReady: state.paid,
        storeSetUp:
          state.name !== undefined && state.payoutListId !== undefined && productCount > 0,
        domainSet: state.nip05 !== undefined,
      },
      usage: {
        month: '2027-01',
        paidOrders: state.paidOrders,
        ordersPerMonth: 2000,
        products: 100,
      },
    };
  }

  storeRead(): Body {
    const { state } = this;
    return {
      tenantId: TENANT_ID,
      choice: choiceOf(state),
      products: state.products,
      storePubkey: state.paid ? STORE_PUBKEY : null,
      pending: this.queued.length > 0,
      refused: null,
      relayHints: ['wss://relay.elisym.network'],
      loader: null,
      waitingChoice: null,
      waitingProducts: null,
      ownerRefusal: null,
      keptPayoutList:
        state.payoutListId === undefined ? null : { id: state.payoutListId, createdAt: LIST_AT },
      publishing: this.queued.length > 0,
    };
  }

  private save(kind: Queued['kind']): Answer {
    return (body) => {
      this.queued.push({ kind, body: record(body) });
      if (this.keepsAtOnce) {
        this.keep();
      }
      return { body: { tenantId: TENANT_ID, cycleId: 1 } };
    };
  }

  /** The routes of this store, as its owner calls them. */
  routes(): Record<string, Answer> {
    const path = `/tenants/${TENANT_ID}`;
    return {
      'GET /owner': () => ({ body: { tenantId: TENANT_ID, termsVersion: '2026-10-31' } }),
      [`GET ${path}`]: () => ({ body: this.view() }),
      [`GET ${path}/status`]: () => ({ body: this.status() }),
      [`GET ${path}/store`]: () => ({ body: this.storeRead() }),
      [`GET ${path}/orders`]: () => ({
        body: {
          tenantId: TENANT_ID,
          orders: this.state.orders,
          answeredByHand: [],
          closed: [],
          unresolvedPayments: [],
        },
      }),
      [`POST ${path}/store`]: this.save('store'),
      [`POST ${path}/products`]: this.save('products'),
      [`POST ${path}/owner-events`]: this.save('owner-events'),
      [`POST ${path}/launch`]: () => {
        this.state.activated = true;
        this.state.runState = 'starting';
        return { body: { tenantId: TENANT_ID, activatedAt: NOW, cycleId: 2 } };
      },
    };
  }
}

export interface FakeCloud {
  routes: Map<string, Answer>;
  /** Every request, in order, with its JSON body and the pubkey that signed it. */
  calls: { method: string; path: string; body: unknown; signer: string | undefined }[];
  fetcher: (request: Request) => Promise<Response>;
}

/**
 * The signer of a request's Nostr auth event, when it is one for this URL and
 * method that signs this body (its `payload` tag the body's sha256; a request
 * with no body may carry none), as cloud-api's `acceptAuthBody` checks it.
 */
function signerOf(request: Request, bytes: Uint8Array): string | undefined {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Nostr ')) {
    return undefined;
  }
  try {
    const event: unknown = JSON.parse(atob(header.slice('Nostr '.length)));
    const fields = record(event);
    const tags = Array.isArray(fields.tags) ? fields.tags : [];
    const tag = (name: string): unknown =>
      tags.find((each) => Array.isArray(each) && each[0] === name)?.[1];
    const payload = tag('payload');
    const signsBody =
      payload === createHash('sha256').update(bytes).digest('hex') ||
      (bytes.length === 0 && payload === undefined);
    const fits =
      fields.kind === 27235 &&
      tag('u') === request.url &&
      tag('method') === request.method &&
      signsBody;
    const signed = fits && verifyEvent(JSON.parse(atob(header.slice('Nostr '.length))));
    return signed && typeof fields.pubkey === 'string' ? fields.pubkey : undefined;
  } catch {
    return undefined;
  }
}

/** A fake cloud answering from `routes`; any other route answers 404, as cloud-api does. */
export function fakeCloud(routes: Record<string, Answer>): FakeCloud {
  const table = new Map(Object.entries(routes));
  const calls: FakeCloud['calls'] = [];
  const fetcher = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    const signer = signerOf(request, bytes);
    calls.push({ method: request.method, path: url.pathname, body, signer });
    const headers = { date: new Date().toUTCString() };
    // `/tiers` alone is served unsigned (before the routes).
    if (signer === undefined && url.pathname !== '/tiers') {
      return Response.json({ error: 'malformed' }, { status: 401, headers });
    }
    const answer = table.get(`${request.method} ${url.pathname}`);
    if (answer === undefined) {
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    }
    const given = typeof answer === 'function' ? answer(body) : answer;
    return Response.json(given.body, { status: given.status ?? 200, headers });
  };
  return { routes: table, calls, fetcher };
}
