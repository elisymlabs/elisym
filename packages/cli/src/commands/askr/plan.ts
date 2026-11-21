/**
 * `askr plan free` (5.9): the owner's explicit choice of Free, the store live
 * at once. `askr plan <starter|growth|pro|scale> [--yearly]`: a Stripe
 * Checkout link for the human to pay at (never opened here); the store goes
 * live once the payment went through. The prompt runs either only on the
 * human's explicit choice.
 */
import { UPGRADE } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import type { Session } from './session';
import {
  CONTACT_HINT,
  INIT_FIRST_HINT,
  readView,
  refusalExit,
  tierOf,
  stoppedKinds,
  useOwnerKey,
  waitPublished,
} from './store';
import type { StoreView } from './types';

const FREE = 'free';
const PAID_PLANS: readonly string[] = ['starter', 'growth', 'pro', 'scale'];

export interface PlanOptions {
  /** A paid plan billed yearly instead of monthly. */
  yearly?: boolean;
}

const PAID_HINT = 'paid plans: message us with your Store ID';

/** A paid plan: the checkout link the human opens to pay; the store activates after payment. */
async function runCheckout(
  session: Session,
  plan: string,
  options: PlanOptions,
): Promise<CommandOutcome> {
  const key = await useOwnerKey(session);
  const interval = options.yearly === true ? 'year' : 'month';
  const result = await session.call<{ url: string }>('POST', '/v1/admin/billing/checkout', {
    plan,
    interval,
  });
  if (!result.ok) {
    switch (result.code) {
      case 'billing_unavailable':
      case 'plan_unavailable':
        throw new AskrExit(EXIT.LIMIT, result.code, {
          hint: `this plan cannot be bought here right now: ${PAID_HINT}`,
          fields: { upgrade: UPGRADE },
        });
      case 'subscription_exists':
        throw new AskrExit(EXIT.REFUSED, 'subscription_exists', {
          hint: `the store already has a paid plan: change it under Manage billing in the admin (${session.adminUrl})`,
        });
      case 'suspended':
        throw new AskrExit(EXIT.REFUSED, 'suspended', {
          hint: `the store is suspended: ${CONTACT_HINT}`,
        });
      case 'operator_managed':
        throw new AskrExit(EXIT.REFUSED, 'operator_managed', {
          hint: `we manage this store's plan: ${CONTACT_HINT}`,
        });
      default:
        // no_store (run askr init first) and moved are mapped as every command maps them.
        throw refusalExit(session, result);
    }
  }
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      storeId: key.storeId,
      plan,
      interval,
      checkoutUrl: result.body.url,
      hint: 'give the human this checkoutUrl to open and pay (never open it yourself); the store goes live once the payment went through: check with askr status',
    },
  };
}

export async function runPlan(
  session: Session,
  plan: string,
  options: PlanOptions = {},
): Promise<CommandOutcome> {
  if (PAID_PLANS.includes(plan)) {
    return runCheckout(session, plan, options);
  }
  if (plan !== FREE) {
    throw new AskrExit(EXIT.BAD_INPUT, 'unknown_plan', {
      hint: 'plans: free, starter, growth, pro, scale (Enterprise: message us with your Store ID)',
      fields: { upgrade: UPGRADE },
    });
  }
  if (options.yearly === true) {
    throw new AskrExit(EXIT.BAD_INPUT, 'bad_flag', { hint: '--yearly is for a paid plan' });
  }
  const key = await useOwnerKey(session);
  const result = await session.call<StoreView & { activation: string }>(
    'POST',
    '/v1/admin/store/plan',
    { plan: FREE },
  );
  if (!result.ok) {
    switch (result.code) {
      case 'capacity_reached':
        throw new AskrExit(EXIT.LIMIT, 'capacity_reached', {
          hint: 'Free is full right now: message us with your Store ID, or try again tomorrow',
          fields: { upgrade: UPGRADE, resume: session.resumeSame() },
        });
      case 'free_unavailable':
        throw new AskrExit(EXIT.LIMIT, 'free_unavailable', {
          hint: 'Free cannot be started right now: message us with your Store ID',
          fields: { upgrade: UPGRADE },
        });
      case 'no_settings':
      case 'no_store':
        throw new AskrExit(EXIT.BAD_INPUT, result.code, { hint: INIT_FIRST_HINT });
      case 'not_pending':
        throw new AskrExit(EXIT.REFUSED, 'not_pending', {
          hint: `the store is suspended: ${CONTACT_HINT}`,
        });
      case 'operator_managed':
        throw new AskrExit(EXIT.REFUSED, 'operator_managed', {
          hint: `we manage this store's plan: ${CONTACT_HINT}`,
        });
      case 'read_failed':
        throw session.notDone('read_failed', {
          hint: 'the store changed meanwhile: run the resume command in about a minute',
        });
      default:
        throw refusalExit(session, result);
    }
  }
  const activation = result.body.activation;
  const waited = await waitPublished(
    session,
    await readView(session),
    (view) =>
      new AskrExit(EXIT.REFUSED, 'publish_stopped', {
        hint: 'run the same askr init line once (it stores the event again); if it stays stopped, report this to us with your Store ID',
        fields: { kinds: stoppedKinds(view) },
      }),
  );
  if (!waited.published) {
    throw session.notDone('publication_pending', {
      hint: 'the store is active; its settings are being published: run the resume command in about a minute',
      fields: { activation, published: false },
    });
  }
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      storeId: key.storeId,
      status: waited.view.status,
      tier: tierOf(waited.view),
      activation,
      published: true,
    },
  };
}
