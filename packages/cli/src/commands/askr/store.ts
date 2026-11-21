/**
 * What every `askr` command shares once it has a session: the owner key, the
 * store view, the mapping of the server's refusals to the exit table (5.0),
 * the view-dependent `inactive` hint and the publication wait.
 */
import { ADMIN_URL, CONTACT_URL, STORE_POLL_MS, UPGRADE } from './constants';
import { AskrExit, EXIT, type ExitCode } from './errors';
import { type OwnerKey, readOwnerKey } from './owner-key';
import type { ApiResult, Session } from './session';
import type { BillingView, StoreView } from './types';

export const CHOOSE_PLAN_HINT =
  'choose a plan: askr plan free (only if the human chose Free), or message us with your Store ID for a paid plan';
/** The same, when the server takes payments: a paid plan is a checkout link for the human. */
export const CHOOSE_PLAN_BILLING_HINT =
  'choose a plan: askr plan free (only if the human chose Free), or askr plan <starter|growth|pro|scale> [--yearly] for the paid plan the human chose, then give them its checkoutUrl to pay';
export const CONTACT_HINT = `message us with your Store ID: ${CONTACT_URL}`;
export const INIT_FIRST_HINT = 'run askr init first';
const CLOCK_HINT = "check this computer's clock: it is off by more than a minute";
const UNAUTHORIZED_HINTS: Readonly<Record<string, string>> = {
  stale: CLOCK_HINT,
  url: 'the server is reached at another address than it signs for',
};
const MOVED_HINT =
  "this key's store moved: finish the move in the admin, it shows the old settings to check and sign";

/** The profile's owner key, set as the key every call is signed with. */
export async function useOwnerKey(session: Session): Promise<OwnerKey> {
  const key = await readOwnerKey(session.deps.home, session.profile);
  if (key === undefined) {
    throw new AskrExit(EXIT.KEY, 'no_key', {
      hint: `this computer has no Askr owner key for the profile "${session.profile}": ${INIT_FIRST_HINT}`,
    });
  }
  session.signAs(key.secretKey);
  return key;
}

/** The plan as the commands print it: its name and the limits the merchant sees. */
export function tierOf(view: Pick<StoreView, 'tier'>): Record<string, unknown> | null {
  return view.tier === null
    ? null
    : { name: view.tier.name, maxProducts: view.tier.maxProducts, branding: view.tier.branding };
}

/** A pending store without a tier is the only one waiting for its owner's plan choice (5.5). */
export function awaitingPlanOf(view: Pick<StoreView, 'status' | 'tier'>): boolean {
  return view.status === 'pending' && view.tier === null;
}

/** What the agent is told about a store that is not active, by its view (5.0). */
export function planHintOf(view: Pick<StoreView, 'status' | 'tier' | 'billing'>): string {
  if (!awaitingPlanOf(view)) {
    return CONTACT_HINT;
  }
  return view.billing?.checkoutAvailable === true ? CHOOSE_PLAN_BILLING_HINT : CHOOSE_PLAN_HINT;
}

/**
 * How to move to a bigger plan, by what the server says of billing: a checkout from
 * `askr plan` when the store can buy one, Manage billing in the admin when it already pays,
 * else message us (a server without billing, or a plan we manage).
 */
export function upgradeOf(
  billing: BillingView | undefined,
  adminUrl: string = ADMIN_URL,
): Record<string, string> {
  if (billing?.enabled !== true || billing.operatorManaged === true) {
    return UPGRADE;
  }
  if (billing.checkoutAvailable) {
    return {
      ...UPGRADE,
      howTo:
        'Run askr plan <starter|growth|pro|scale> [--yearly] for the paid plan the human chose, then give them its checkoutUrl to pay',
    };
  }
  if (billing.manageable) {
    return {
      ...UPGRADE,
      howTo: 'Change the paid plan under Manage billing in the admin',
      admin: adminUrl,
    };
  }
  return UPGRADE;
}

/** A write on a store that is not active: exit 5 with the view-dependent hint. */
export function inactiveExit(
  view: Pick<StoreView, 'status' | 'tier' | 'billing'>,
  exitCode: ExitCode = EXIT.LIMIT,
): AskrExit {
  return new AskrExit(exitCode, 'inactive', {
    hint: `the store is ${view.status}, not active: ${planHintOf(view)}`,
    fields: {
      status: view.status,
      awaitingPlan: awaitingPlanOf(view),
      upgrade: upgradeOf(view.billing),
    },
  });
}

export function movedExit(fields?: Record<string, unknown>): AskrExit {
  return new AskrExit(EXIT.REFUSED, 'moved_store', {
    hint: MOVED_HINT,
    ...(fields === undefined ? {} : { fields }),
  });
}

function serverMessage(result: ApiResult<unknown>): string | undefined {
  if (result.ok) {
    return undefined;
  }
  const message = result.detail.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * A refusal no command handles itself, mapped to the exit table: the clock,
 * a moved store, no store, the server unavailable (exit 4, resume), and any
 * other refusal (exit 3).
 */
export function refusalExit(session: Session, result: ApiResult<unknown>): AskrExit {
  if (result.ok) {
    return new AskrExit(EXIT.REFUSED, 'unexpected');
  }
  const message = serverMessage(result);
  const fields: Record<string, unknown> = { status: result.status };
  if (result.status === 401) {
    const reason = typeof result.detail.reason === 'string' ? result.detail.reason : 'unknown';
    return new AskrExit(EXIT.REFUSED, reason === 'stale' ? 'stale' : 'unauthorized', {
      hint: UNAUTHORIZED_HINTS[reason] ?? 'the server did not accept the signed request',
      fields: { ...fields, reason },
    });
  }
  if (result.status === 409 && result.code === 'moved') {
    return movedExit();
  }
  if (result.status === 404 && result.code === 'no_store') {
    return new AskrExit(EXIT.BAD_INPUT, 'no_store', { hint: INIT_FIRST_HINT });
  }
  if (result.status === 429) {
    return session.notDone('rate_limited', {
      hint: 'the server asked to slow down: run the resume command in about a minute',
      fields: { retryAfterSeconds: 60 },
    });
  }
  if (result.status >= 500 || result.status === 0) {
    return session.notDone(result.code === 'unexpected' ? 'unavailable' : result.code, {
      hint: 'the Askr server is not available just now: run the resume command in about a minute',
      ...(message === undefined ? {} : { message }),
    });
  }
  return new AskrExit(EXIT.REFUSED, result.code, {
    ...(message === undefined ? {} : { message }),
    fields,
  });
}

/** `GET /v1/admin/store`, or the mapped refusal. */
export async function readView(session: Session): Promise<StoreView> {
  const result = await session.call<StoreView>('GET', '/v1/admin/store');
  if (!result.ok) {
    throw refusalExit(session, result);
  }
  return result.body;
}

export interface PublishWait {
  view: StoreView;
  published: boolean;
}

/**
 * Poll the view until every stored event is published (init step 10, 5.9),
 * within the deadline. A stopped event ends the wait (`stopped`), a deadline
 * ends it with `published: false`.
 */
export async function waitPublished(
  session: Session,
  first: StoreView,
  onStopped: (view: StoreView) => AskrExit,
): Promise<PublishWait> {
  let view = first;
  for (;;) {
    if (view.events.failing.some((event) => event.stopped)) {
      throw onStopped(view);
    }
    if (view.events.pending === 0) {
      return { view, published: true };
    }
    if (session.remaining() <= STORE_POLL_MS) {
      return { view, published: false };
    }
    await session.sleep(STORE_POLL_MS);
    view = await readView(session);
  }
}

/** The stopped event's kind, for `publish_stopped`. */
export function stoppedKinds(view: StoreView): number[] {
  return view.events.failing.filter((event) => event.stopped).map((event) => event.kind);
}
