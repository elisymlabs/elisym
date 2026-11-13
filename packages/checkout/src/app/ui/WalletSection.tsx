import type { Asset } from '@elisym/pay-core';
import type { Problem, Rail, WalletChoice } from '../session';
import { NoWallet } from './NoWallet';
import { ProblemNote } from './ProblemNote';
import { StepHeading } from './StepHeading';
import { WalletPicker } from './WalletPicker';

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
  const unsupported = problem?.reason === 'tempo_unsupported';
  const failedWallet = unsupported ? problem.wallet : undefined;
  return (
    <div class="step" data-step="wallets">
      {wallets.length === 0 && !unsupported ? (
        <StepHeading level={3}>Choose a wallet</StepHeading>
      ) : null}
      <ProblemNote
        problem={unsupported ? undefined : problem}
        asset={asset}
        rail={rail}
        {...(onCheckWallet === undefined ? {} : { onCheckWallet })}
      />
      {wallets.length === 0 && !unsupported ? (
        <NoWallet chain={rail} phone={phone} />
      ) : (
        <WalletPicker
          wallets={wallets}
          showLabel={false}
          label="Wallet"
          disabled={locked}
          unsupported={unsupported}
          failedWallet={failedWallet}
          onPay={onPay}
        />
      )}
    </div>
  );
}
