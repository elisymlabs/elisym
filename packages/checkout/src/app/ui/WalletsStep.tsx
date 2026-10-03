import { type Problem, type View, payoutPaying } from '../session';
import { NoWallet } from './NoWallet';
import { PayingLine } from './PayingLine';
import { ProblemNote } from './ProblemNote';
import { StepHeading } from './StepHeading';
import { WalletRow } from './WalletRow';

interface Props {
  view: Extract<View, { kind: 'offer' }>;
  problem: Problem | undefined;
  phone: boolean;
  onBack(): void;
  onPay(name: string): void;
}

export function WalletsStep({ view, problem, phone, onBack, onPay }: Props) {
  const paying = payoutPaying(view.payout);
  const tempo = paying.chain === 'tempo';
  return (
    <div class="step" data-step="wallets">
      <button type="button" class="back" onClick={onBack}>
        Back
      </button>
      <StepHeading>Choose a wallet</StepHeading>
      <PayingLine paying={paying} />
      <ProblemNote problem={problem} asset={paying.asset} tempo={tempo} />
      {view.wallets.length === 0 ? (
        <NoWallet chain={paying.chain} phone={phone} />
      ) : (
        <div class="wallet-list">
          {view.wallets.map((wallet) => (
            <WalletRow
              key={wallet.name}
              wallet={wallet}
              tempo={tempo}
              disabled={!view.confirmed}
              onPick={onPay}
            />
          ))}
        </div>
      )}
    </div>
  );
}
