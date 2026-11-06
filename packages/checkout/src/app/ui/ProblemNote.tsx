import { ErrorIcon } from './ErrorIcon';
import type { Asset } from '@elisym/pay-core';
import type { Problem, Rail } from '../session';
import { EarlierPaymentNote } from './EarlierPaymentNote';
import { problemText, statusSubtitle } from './text';
import { problemHeading } from './problem-heading';

interface Props {
  problem: Problem | undefined;
  /** A progress screen already has its own heading and icon. */
  detailOnly?: boolean;
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
  detailOnly = false,
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
      class={`problem error-message${reveal ? ' reveal' : ''}${detailOnly ? ' error-message-detail' : ''}`}
      data-problem-reason={problem.reason}
      role="alert"
      tabindex={-1}
      data-problem-note=""
    >
      {detailOnly ? null : <>
        <ErrorIcon size={28} />
        <h4 class="error-message-title">{problemHeading(problem)}</h4>
      </>}
      <p class="error-message-description">{statusSubtitle(
        problemText(problem, asset, rail, canPress) +
        (rail === 'tempo' && problem.reason === 'tempo_unsupported' ? ' MetaMask is known to work.' : '')
      )}</p>
    </div>
  );
}
