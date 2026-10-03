import type { Problem, View } from '../session';

/**
 * Where each problem on the offer belongs. `offer`: the offer itself changed
 * or is wrong as filled in (it shows above the button, and closes the wallet
 * section so the buyer sees it). `wallets`: the wallet or the network failed,
 * and the buyer stays where they were. Exhaustive: a new reason fails the
 * typecheck until it is placed.
 */
export const PROBLEM_PLACE = {
  offer_changed: 'offer',
  bad_email: 'offer',
  offer_refused: 'offer',
  too_late: 'offer',
  no_wallet: 'wallets',
  tempo_unsupported: 'wallets',
  wallet_busy: 'wallets',
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
  wallet_failed: 'wallets',
  wallet_unsupported: 'wallets',
  attempt_over: 'wallets',
} as const satisfies Record<Problem['reason'], 'offer' | 'wallets'>;

/** The panel's own state over the session's views: whether the wallet section is open. */
export interface Panel {
  walletsOpen: boolean;
  /** The problem object of the last offer seen: only a new object can close the section. */
  problem: Problem | undefined;
  /** A problem the buyer moved on from ("Choose wallet"): not shown again. */
  dismissed: Problem | undefined;
}

export const INITIAL_PANEL: Panel = {
  walletsOpen: false,
  problem: undefined,
  dismissed: undefined,
};

/**
 * The panel after `view` arrives. Progress and the old-prompt question keep it
 * (they resume the same payment); any other non-offer view closes the wallet
 * section, so whatever offer comes next starts closed. On an offer, only a new
 * offer-class problem object closes it: a wallet registering (the same object)
 * or the buyer's own payout choice never does.
 */
export function advancePanel(panel: Panel, view: View | undefined): Panel {
  if (view === undefined || view.kind === 'working' || view.kind === 'old_prompt') {
    return panel;
  }
  if (view.kind !== 'offer') {
    return { ...panel, walletsOpen: false };
  }
  const problem = view.problem;
  const newOfferProblem =
    problem !== undefined && problem !== panel.problem && PROBLEM_PLACE[problem.reason] === 'offer';
  return {
    walletsOpen: newOfferProblem ? false : panel.walletsOpen,
    problem,
    dismissed: panel.dismissed,
  };
}

/** "Choose wallet": the section opens, and an offer-class problem on screen is moved on from. */
export function openWallets(panel: Panel, problem: Problem | undefined): Panel {
  const offerProblem =
    problem !== undefined && PROBLEM_PLACE[problem.reason] === 'offer' ? problem : undefined;
  return { ...panel, walletsOpen: true, dismissed: offerProblem ?? panel.dismissed };
}

/** The problem to show: the view's, unless the buyer already moved on from that very one. */
export function shownProblem(panel: Panel, problem: Problem | undefined): Problem | undefined {
  return problem === panel.dismissed ? undefined : problem;
}
