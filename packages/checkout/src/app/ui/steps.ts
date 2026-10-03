import type { PricedPayout } from '@elisym/commerce/buyer';
import type { Problem, View } from '../session';

/** The two screens over one offer: what is bought, then which wallet pays. */
export type Step = 'review' | 'wallets';

/**
 * Where each problem on the offer is shown. `review`: the buyer must look at
 * the offer again (it changed, needs a confirmation, or the email is wrong).
 * `wallets`: the wallet or the network failed, and the buyer stays there.
 * Exhaustive: a new reason fails the typecheck until it is placed.
 */
export const PROBLEM_STEP = {
  offer_changed: 'review',
  confirm_first: 'review',
  bad_email: 'review',
  offer_refused: 'review',
  too_late: 'review',
  no_wallet: 'wallets',
  rpc_error: 'wallets',
  clock_skew: 'wallets',
  wrong_chain: 'wallets',
  rejected: 'wallets',
  insufficient_token: 'wallets',
  insufficient_sol: 'wallets',
  self_payment: 'wallets',
  order_not_acknowledged: 'wallets',
  no_store_inbox: 'wallets',
  failed: 'wallets',
  policy_blocked: 'wallets',
  late_approval: 'wallets',
  // Never reach the offer while on wallets (they pass through the waiting
  // screen, which resets the step), kept here so the table stays complete.
  wallet_failed: 'wallets',
  wallet_unsupported: 'wallets',
  attempt_over: 'wallets',
} as const satisfies Record<Problem['reason'], Step>;

export interface StepTracker {
  step: Step;
  /** The problem object of the last offer seen: only a new object can force `review`. */
  problem: Problem | undefined;
  /** The selected payout's value on the last offer seen. */
  payoutKey: string | undefined;
  /** A problem the buyer moved on from: not shown again. */
  dismissed: Problem | undefined;
}

export const INITIAL_TRACKER: StepTracker = {
  step: 'review',
  problem: undefined,
  payoutKey: undefined,
  dismissed: undefined,
};

/** By value, never by object: a reload replaces the objects even when nothing changed. */
export function payoutKey(payout: PricedPayout): string {
  return `${payout.target.caip19.id} ${payout.target.address} ${payout.amount.toString()}`;
}

/** The step after `view` arrives. A wallet registering (the same problem object) never moves it. */
export function advanceStep(tracker: StepTracker, view: View | undefined): StepTracker {
  if (view === undefined || view.kind === 'working' || view.kind === 'old_prompt') {
    // In progress, or the old-prompt question that resumes the same payment.
    return tracker;
  }
  if (view.kind !== 'offer') {
    // Waiting, delivered, refunded, cancelled, blocked, refused: whatever offer
    // comes next (a retry that ended, Buy again) starts at review.
    return { ...tracker, step: 'review' };
  }
  const key = payoutKey(view.payout);
  const problem = view.problem;
  const newReviewProblem =
    problem !== undefined &&
    problem !== tracker.problem &&
    PROBLEM_STEP[problem.reason] === 'review';
  const forced =
    (view.confirm.length > 0 && !view.confirmed) ||
    newReviewProblem ||
    (tracker.payoutKey !== undefined && tracker.payoutKey !== key);
  return {
    step: forced ? 'review' : tracker.step,
    problem,
    payoutKey: key,
    dismissed: tracker.dismissed,
  };
}

/** The problem to show: the view's, unless the buyer already moved on from that very one. */
export function shownProblem(
  tracker: StepTracker,
  problem: Problem | undefined,
): Problem | undefined {
  return problem === tracker.dismissed ? undefined : problem;
}
