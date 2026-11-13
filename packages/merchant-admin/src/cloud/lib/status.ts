/**
 * The store's state as the guided flow polls it (`GET /tenants/:id/status`,
 * plan `cloud-pricing-and-onboarding.md` 3): every field checked, so a
 * malformed answer is a failure, never a wrong step. A step waits for a save
 * by this state, never by a cycle id.
 */
import { fieldOf } from './fields';
import { isTime } from './store-view';

export const RUN_STATES = [
  'gone',
  'not_launched',
  'held',
  'paused_by_owner',
  'paused_payment_due',
  'off_sale',
  'needs_resign',
  'could_not_start',
  'applying',
  'live',
  'starting',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RAILS = ['solana', 'tempo', 'ethereum', 'arbitrum', 'base'] as const;
export type Rail = (typeof RAILS)[number];

export const EDIT_KINDS = ['store', 'owner-events', 'products'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** What the store keeps (exactly as sent): what a save is compared with. */
export interface KeptState {
  name: string | undefined;
  rails: Rail[];
  payoutList: { id: string; createdAt: number } | undefined;
  productsDigest: string;
}

/** Launch's checks but the domain: each true when it holds; `activation` is a refusal code or none. */
export interface LaunchGates {
  activation: string | undefined;
  noCyclePending: boolean;
  homeReady: boolean;
  storeSetUp: boolean;
  domainSet: boolean;
}

export interface StoreStatus {
  tier: string;
  tierName: string;
  effectivePaidUntil: number | undefined;
  storePubkey: string | undefined;
  productCount: number;
  /** A save (any kind) is still to apply. */
  pending: boolean;
  kept: KeptState;
  ownerRefusal: 'revoked' | 'resign' | undefined;
  /** A re-sign answers the owner refusal and is still to be checked. */
  resignInFlight: boolean;
  /** Per kind, what the store refused in the newest finished save; undefined when none. */
  lastProblems: Record<EditKind, string[] | undefined>;
  runState: RunState;
  gates: LaunchGates;
  usage: {
    month: string;
    paidOrders: number;
    /** undefined: no cap. */
    ordersPerMonth: number | undefined;
    products: number;
  };
}

/** The status, or `gone` for a store handed over or destroyed. */
export type StatusRead = { gone: true } | ({ gone: false } & StoreStatus);

const HEX_KEY = /^[0-9a-f]{64}$/;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

function keptOf(value: unknown): KeptState | undefined {
  const name = fieldOf(value, 'name');
  const rails = fieldOf(value, 'rails');
  const payoutList = fieldOf(value, 'payoutList');
  const digest = fieldOf(value, 'productsDigest');
  if (
    (name !== null && typeof name !== 'string') ||
    !Array.isArray(rails) ||
    typeof digest !== 'string' ||
    !HEX_KEY.test(digest)
  ) {
    return undefined;
  }
  const knownRails = rails.map((rail) => oneOf(rail, RAILS));
  if (knownRails.some((rail) => rail === undefined)) {
    return undefined;
  }
  let list: KeptState['payoutList'];
  if (payoutList !== null) {
    const id = fieldOf(payoutList, 'id');
    const createdAt = fieldOf(payoutList, 'createdAt');
    if (typeof id !== 'string' || !isTime(createdAt)) {
      return undefined;
    }
    list = { id, createdAt };
  }
  return {
    name: name ?? undefined,
    rails: knownRails.filter((rail) => rail !== undefined),
    payoutList: list,
    productsDigest: digest,
  };
}

function problemsOf(value: unknown): Record<EditKind, string[] | undefined> | undefined {
  const problems: Partial<Record<EditKind, string[] | undefined>> = {};
  for (const kind of EDIT_KINDS) {
    const list = fieldOf(value, kind);
    if (list !== null && !isStringList(list)) {
      return undefined;
    }
    problems[kind] = list ?? undefined;
  }
  return {
    store: problems.store,
    'owner-events': problems['owner-events'],
    products: problems.products,
  };
}

function gatesOf(value: unknown): LaunchGates | undefined {
  const activation = fieldOf(value, 'activation');
  const flags = ['noCyclePending', 'homeReady', 'storeSetUp', 'domainSet'].map((name) =>
    fieldOf(value, name),
  );
  if (
    (activation !== null && typeof activation !== 'string') ||
    flags.some((flag) => typeof flag !== 'boolean')
  ) {
    return undefined;
  }
  const [noCyclePending, homeReady, storeSetUp, domainSet] = flags;
  return {
    activation: activation ?? undefined,
    noCyclePending: noCyclePending === true,
    homeReady: homeReady === true,
    storeSetUp: storeSetUp === true,
    domainSet: domainSet === true,
  };
}

function usageOf(value: unknown): StoreStatus['usage'] | undefined {
  const month = fieldOf(value, 'month');
  const paidOrders = fieldOf(value, 'paidOrders');
  const ordersPerMonth = fieldOf(value, 'ordersPerMonth');
  const products = fieldOf(value, 'products');
  if (
    typeof month !== 'string' ||
    !isCount(paidOrders) ||
    (ordersPerMonth !== null && !isCount(ordersPerMonth)) ||
    !isCount(products)
  ) {
    return undefined;
  }
  return { month, paidOrders, ordersPerMonth: ordersPerMonth ?? undefined, products };
}

/** The status from an answer's body, or undefined when any field is not what it must be. */
export function statusReadOf(body: unknown): StatusRead | undefined {
  const runState = oneOf(fieldOf(body, 'runState'), RUN_STATES);
  if (runState === 'gone') {
    return { gone: true };
  }
  const tier = fieldOf(body, 'tier');
  const tierName = fieldOf(body, 'tierName');
  const paidUntil = fieldOf(body, 'effectivePaidUntil');
  const storePubkey = fieldOf(body, 'storePubkey');
  const productCount = fieldOf(body, 'productCount');
  const pending = fieldOf(body, 'pending');
  const kept = keptOf(fieldOf(body, 'kept'));
  const ownerRefusal = fieldOf(body, 'ownerRefusal');
  const resignInFlight = fieldOf(body, 'resignInFlight');
  const lastProblems = problemsOf(fieldOf(body, 'lastProblems'));
  const gates = gatesOf(fieldOf(body, 'gates'));
  const usage = usageOf(fieldOf(body, 'usage'));
  if (
    runState === undefined ||
    typeof tier !== 'string' ||
    typeof tierName !== 'string' ||
    (paidUntil !== null && !isTime(paidUntil)) ||
    (storePubkey !== null && (typeof storePubkey !== 'string' || !HEX_KEY.test(storePubkey))) ||
    !isCount(productCount) ||
    typeof pending !== 'boolean' ||
    kept === undefined ||
    (ownerRefusal !== null && ownerRefusal !== 'revoked' && ownerRefusal !== 'resign') ||
    typeof resignInFlight !== 'boolean' ||
    lastProblems === undefined ||
    gates === undefined ||
    usage === undefined
  ) {
    return undefined;
  }
  return {
    gone: false,
    tier,
    tierName,
    effectivePaidUntil: paidUntil ?? undefined,
    storePubkey: storePubkey ?? undefined,
    productCount,
    pending,
    kept,
    ownerRefusal: ownerRefusal ?? undefined,
    resignInFlight,
    lastProblems,
    runState,
    gates,
    usage,
  };
}

/** Names in code-unit order (never the locale's): the order cloud-api sorts them in. */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The digest the store keeps of its product set, computed from a draft the
 * same way (cloud-api `status.ts`): lowercase hex sha256 of `{` + the entries
 * sorted by name as strings, each `"name":"text"` as JSON writes them, joined
 * by `,` + `}`. Written from the sorted entries, never an object: JS lists
 * integer-like keys first.
 */
export async function productsDigest(products: Readonly<Record<string, string>>): Promise<string> {
  const entries = Object.entries(products).sort(([left], [right]) => compareNames(left, right));
  const json = `{${entries.map(([name, text]) => `${JSON.stringify(name)}:${JSON.stringify(text)}`).join(',')}}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
