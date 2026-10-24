import type { Asset } from '@elisym/pay-core';
import type { Problem, Rail, WalletChoice } from '../session';
import { NoWallet } from './NoWallet';
import { ProblemNote } from './ProblemNote';
import { StepHeading } from './StepHeading';
import { WalletRow } from './WalletRow';

interface Props {
  wallets: WalletChoice[];
  rail: Rail;
  asset: Asset;
  /** A wallet-class problem, shown where the buyer is. */
  problem: Problem | undefined;
  phone: boolean;
  /** A wallet was pressed: no second press until the next view. */
  locked: boolean;
  onPay(name: string): void;
  onCheckWallet?: () => void;
}

/** The wallets that can pay the chosen payout, under the offer: the payout above stays editable. */
export function WalletSection({
  wallets,
  rail,
  asset,
  problem,
  phone,
  locked,
  onPay,
  onCheckWallet,
}: Props) {
  return (
    <div class="step" data-step="wallets">
      <StepHeading level={3}>Choose a wallet</StepHeading>
      <ProblemNote
        problem={problem}
        asset={asset}
        rail={rail}
        {...(onCheckWallet === undefined ? {} : { onCheckWallet })}
      />
      {wallets.length === 0 ? (
        <NoWallet chain={rail} phone={phone} />
      ) : (
        <div class="wallet-list">
          {wallets.map((wallet) => (
            <WalletRow key={wallet.name} wallet={wallet} disabled={locked} onPick={onPay} />
          ))}
        </div>
      )}
    </div>
  );
}
