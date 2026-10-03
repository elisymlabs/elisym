import type { Asset } from '@elisym/pay-core';
import type { Problem } from '../session';
import { problemText } from './text';

interface Props {
  problem: Problem | undefined;
  asset: Asset;
  /** A Tempo payment: wallets that cannot add the chain are common; one that can is named. */
  tempo?: boolean;
}

export function ProblemNote({ problem, asset, tempo = false }: Props) {
  if (problem === undefined) {
    return null;
  }
  return (
    <div class="problem" role="alert" tabindex={-1} data-problem-note="">
      <p>{problemText(problem, asset)}</p>
      {tempo && problem.reason === 'no_wallet' ? <p>MetaMask is known to work.</p> : null}
    </div>
  );
}
