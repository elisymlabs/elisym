/**
 * `askr status` (5.5): the profile's store as the server and the relay show
 * it, and with `--probe` a gateway session request like the widget's. No
 * write, no LLM call; product text never printed (counts and slugs only).
 */
import Decimal from 'decimal.js-light';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { summaryOfRun } from './connector-run';
import { PROBE_RETRY_MS } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import { readOwnerKey } from './owner-key';
import { readListings, readPolicySlugs, readSigned } from './read';
import type { Session } from './session';
import { awaitingPlanOf, movedExit, planHintOf, refusalExit, tierOf, upgradeOf } from './store';
import type { StoreView } from './types';

export interface StatusOptions {
  probe?: boolean;
}

type ProbeResult =
  | 'ok'
  | 'not_ready'
  | 'forbidden'
  | 'inactive'
  | 'budget'
  | 'rate_limited'
  | 'moved'
  | 'error';

interface Probe {
  origin: string;
  result: ProbeResult;
}

/** A probe not made, and why: printed so an agent never reads a missing `probe` as a pass. */
interface SkippedProbe {
  result: 'skipped';
  reason: string;
}

/** The hint of a `budget` refusal: a store's only spend limit is its plan's monthly budget. */
export const BUDGET_HINT =
  "the store reached its plan's monthly limit, so the chat does not answer until the plan is upgraded or the next month starts: to upgrade, follow upgrade.howTo";

function money(value: string): string {
  try {
    return new Decimal(value).toString();
  } catch {
    return '0';
  }
}

/** The paid plan as the server last heard from Stripe; null from a server without billing. */
function billingOf(view: StoreView): Record<string, unknown> | null {
  const billing = view.billing;
  if (billing === undefined) {
    return null;
  }
  return {
    enabled: billing.enabled,
    plan: billing.plan,
    interval: billing.interval,
    status: billing.status,
    currentPeriodEnd: billing.currentPeriodEnd,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    checkoutAvailable: billing.checkoutAvailable,
  };
}

function connectorOf(view: StoreView): Record<string, unknown> | null {
  const connector = view.connector;
  if (connector === null) {
    return null;
  }
  const run = summaryOfRun(connector.lastStatus);
  return {
    platform: connector.platform,
    url: connector.url,
    enabled: connector.enabled,
    lastRunAt: connector.lastRunAt,
    lastStatus: run?.status ?? null,
    ...(run?.reason === undefined ? {} : { lastReason: run.reason }),
    ...(run?.reason === 'too_many_products' ? { count: run.count, max: run.max } : {}),
    ...(run?.counts === undefined ? {} : { lastCounts: run.counts }),
  };
}

/** One session ticket request as the widget makes it, from `origin`. */
async function probeOnce(session: Session, view: StoreView, origin: string): Promise<ProbeResult> {
  const visitor = getPublicKey(generateSecretKey());
  const result = await session.call(
    'POST',
    '/v1/session',
    { store: view.owner, visitor },
    { unsigned: true, headers: { origin } },
  );
  if (result.ok) {
    return 'ok';
  }
  if (result.status === 429) {
    return 'rate_limited';
  }
  if (result.status === 410) {
    return 'moved';
  }
  if (result.status === 403) {
    return 'forbidden';
  }
  if (result.code === 'not_ready') {
    return 'not_ready';
  }
  const reason = result.detail.reason;
  if (reason === 'inactive') {
    // Right after an activation a store is active with nothing to serve until a worker read it.
    return view.status === 'active' ? 'not_ready' : 'inactive';
  }
  return reason === 'budget' ? 'budget' : 'error';
}

/**
 * The probe, retried every 10 s while the deadline allows on `not_ready` and
 * on `forbidden` (the probed origin is in the newest signed config, so the
 * worker may not have loaded that config yet).
 */
async function probe(session: Session, view: StoreView, origin: string): Promise<Probe> {
  for (;;) {
    const result = await probeOnce(session, view, origin);
    const retried = result === 'not_ready' || result === 'forbidden';
    if (!retried || session.remaining() <= PROBE_RETRY_MS) {
      return { origin, result };
    }
    await session.sleep(PROBE_RETRY_MS);
  }
}

/** A failed probe's exit carries the whole status as its fields, so nothing else is lost. */
function probeExit(
  session: Session,
  view: StoreView,
  probed: Probe,
  status: Record<string, unknown>,
): AskrExit | undefined {
  const fields = { ...status, probe: probed };
  switch (probed.result) {
    case 'ok':
      return undefined;
    case 'not_ready':
      return session.notDone('not_ready', {
        hint: 'the chat is not served yet: run the resume command in about a minute',
        fields,
      });
    case 'rate_limited':
      return session.notDone('rate_limited', {
        hint: 'the gateway asked to slow down: run the resume command in a minute',
        fields: { ...fields, retryAfterSeconds: 60 },
      });
    case 'forbidden':
      return new AskrExit(EXIT.REFUSED, 'forbidden', {
        hint: "the probed origin is not in the store's origins: run askr init --update with the right --origin",
        fields,
      });
    case 'inactive':
      return new AskrExit(EXIT.REFUSED, 'inactive', { hint: planHintOf(view), fields });
    case 'budget':
      return new AskrExit(EXIT.LIMIT, 'budget', {
        hint: BUDGET_HINT,
        fields,
      });
    case 'moved':
      return movedExit(fields);
    default:
      return new AskrExit(EXIT.REFUSED, 'probe_failed', { fields });
  }
}

/** Why the probe is not made: a pending store is served nowhere yet, a store with no origin has no page. */
function skippedProbe(view: StoreView): SkippedProbe {
  return view.status === 'pending'
    ? {
        result: 'skipped',
        reason: 'the store is pending: the chat is not served until its plan is active',
      }
    : { result: 'skipped', reason: 'the store lists no origin' };
}

export async function runStatus(session: Session, options: StatusOptions): Promise<CommandOutcome> {
  const key = await readOwnerKey(session.deps.home, session.profile);
  if (key === undefined) {
    return { exitCode: EXIT.OK, output: { ok: true, profile: session.profile, store: null } };
  }
  session.signAs(key.secretKey);
  const read = await session.call<StoreView>('GET', '/v1/admin/store');
  if (!read.ok && read.status === 404 && read.code === 'no_store') {
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true,
        profile: session.profile,
        store: null,
        ownerKeyFile: key.path,
        hint: 'a key exists but no store yet: askr init creates it with this key',
      },
    };
  }
  if (!read.ok) {
    throw refusalExit(session, read);
  }
  const view = read.body;
  const { config } = await readSigned(session, key.owner, key.secretKey);
  const catalogKey = config?.catalogKey ?? view.catalogKey;
  const policyKey = config?.policyKey ?? view.catalogKey;
  const listings = await readListings(session, catalogKey);
  const policies = await readPolicySlugs(session, policyKey);
  const awaitingPlan = awaitingPlanOf(view);
  const output: Record<string, unknown> = {
    ok: true,
    profile: session.profile,
    storeId: key.storeId,
    status: view.status,
    tier: tierOf(view),
    awaitingPlan,
    name: config?.name ?? null,
    origins: config?.origins ?? [],
    language: config?.language ?? null,
    currency: config?.currency ?? null,
    source: config === undefined ? null : config.source,
    products: { listed: listings.listed.length, visible: listings.visible },
    policies,
    catalogSync: view.catalogSync === null ? null : { state: view.catalogSync.state },
    connector: connectorOf(view),
    events: {
      pending: view.events.pending,
      failing: view.events.failing.length,
    },
    usage: {
      conversations: view.usage.conversations,
      todaySpentUsd: money(view.usage.today.spent),
      monthSpentUsd: money(view.usage.month.spent),
    },
    billing: billingOf(view),
    ownerKeyFile: key.path,
    adminUrl: session.adminUrl,
    upgrade: upgradeOf(view.billing, session.adminUrl),
  };
  if (view.status !== 'active') {
    output.hint = planHintOf(view);
  }
  if (options.probe !== true) {
    return { exitCode: EXIT.OK, output };
  }
  const origin = config?.origins[0];
  if (view.status === 'pending' || origin === undefined) {
    output.probe = skippedProbe(view);
    return { exitCode: EXIT.OK, output };
  }
  const probed = await probe(session, view, origin);
  output.probe = probed;
  const status = Object.fromEntries(Object.entries(output).filter(([name]) => name !== 'ok'));
  const failed = probeExit(session, view, probed, status);
  if (failed !== undefined) {
    throw failed;
  }
  return { exitCode: EXIT.OK, output };
}
