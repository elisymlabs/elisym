import type { Asset } from '@elisym/pay-core';
import type { Problem } from '../session';
import { EarlierPaymentNote } from './EarlierPaymentNote';
import { problemText } from './text';

interface Props {
  problem: Problem | undefined;
  asset: Asset;
  /** A Tempo payment: the hints name only Tempo's wallets, never Solana's (and the reverse). */
  tempo: boolean;
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
  tempo,
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
      <p>{problemText(problem, asset, tempo, canPress)}</p>
      {tempo && problem.reason === 'tempo_unsupported' ? <p>MetaMask is known to work.</p> : null}
    </div>
  );
}
