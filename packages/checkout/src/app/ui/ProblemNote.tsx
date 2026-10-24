import type { Asset } from '@elisym/pay-core';
import type { Problem, Rail } from '../session';
import { EarlierPaymentNote } from './EarlierPaymentNote';
import { problemText } from './text';

interface Props {
  problem: Problem | undefined;
  asset: Asset;
  /** The payout's rail: the hints name only its wallets, never another rail's. */
  rail: Rail;
  /** Fades in on its own: only outside a step that already does (never two at once). */
  reveal?: boolean;
  /** The screen offers something to press now (a wait before its retry does not). */
  canPress?: boolean;
  /** The earlier-payment line's "Check in wallet". */
  onCheckWallet?: () => void;
}

export function ProblemNote({
  problem,
  asset,
  rail,
  reveal = false,
  canPress = true,
  onCheckWallet,
}: Props) {
  if (problem === undefined) {
    return null;
  }
  if (problem.reason === 'earlier_payment') {
    return (
      <EarlierPaymentNote
        problem={problem}
        reveal={reveal}
        {...(onCheckWallet === undefined ? {} : { onCheckWallet })}
      />
    );
  }
  return (
    <div
      class={reveal ? 'problem reveal' : 'problem'}
      role="alert"
      tabindex={-1}
      data-problem-note=""
    >
      <p>{problemText(problem, asset, rail, canPress)}</p>
      {rail === 'tempo' && problem.reason === 'tempo_unsupported' ? (
        <p>MetaMask is known to work.</p>
      ) : null}
    </div>
  );
}
