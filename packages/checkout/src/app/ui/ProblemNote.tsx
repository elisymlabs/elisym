import type { Asset } from '@elisym/pay-core';
import type { Problem } from '../session';
import { problemText } from './text';

interface Props {
  problem: Problem | undefined;
  asset: Asset;
  /** A Tempo payment: wallets that cannot add the chain are common; one that can is named. */
  tempo?: boolean;
  /** Fades in on its own: only outside a step that already does (never two at once). */
  reveal?: boolean;
}

export function ProblemNote({ problem, asset, tempo = false, reveal = false }: Props) {
  if (problem === undefined) {
    return null;
  }
  return (
    <div
      class={reveal ? 'problem reveal' : 'problem'}
      role="alert"
      tabindex={-1}
      data-problem-note=""
    >
      <p>{problemText(problem, asset)}</p>
      {tempo && (problem.reason === 'no_wallet' || problem.reason === 'tempo_unsupported') ? (
        <p>MetaMask is known to work.</p>
      ) : null}
    </div>
  );
}
