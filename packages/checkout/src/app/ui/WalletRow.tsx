import type { WalletChoice } from '../session';
import { usableIcon } from './device';
import { PaymentStageIcon } from './PaymentStageIcon';

interface Props {
  wallet: WalletChoice;
  disabled: boolean;
  unsupported?: boolean;
  expanded?: boolean;
  onPick(name: string): void;
}

export function WalletRow({ wallet, disabled, unsupported = false, expanded, onPick }: Props) {
  const icon = usableIcon(wallet.icon);
  return (
    <button
      type="button"
      class={`wallet-row${unsupported ? ' wallet-row-unsupported' : ''}`}
      disabled={disabled}
      aria-describedby={unsupported ? 'unsupported-wallet-message' : undefined}
      aria-expanded={expanded}
      aria-controls={expanded === undefined ? undefined : 'alternative-wallets'}
      onClick={() => onPick(wallet.name)}
    >
      {icon === undefined ? (
        <span class="monogram" aria-hidden="true">
          {unsupported ? <PaymentStageIcon stage="wallet" /> : (Array.from(wallet.name)[0] ?? '?').toUpperCase()}
        </span>
      ) : (
        <img class="wallet-icon" src={icon} alt="" aria-hidden="true" />
      )}
      <span class="wallet-name">{wallet.name}</span>
      <span class="chevron" aria-hidden="true" />
    </button>
  );
}
