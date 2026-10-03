import type { WalletChoice } from '../session';
import { usableIcon } from './device';

interface Props {
  wallet: WalletChoice;
  /** A Tempo payment: connecting switches the wallet to the Tempo chain. */
  tempo: boolean;
  disabled: boolean;
  onPick(name: string): void;
}

export function WalletRow({ wallet, tempo, disabled, onPick }: Props) {
  const icon = usableIcon(wallet.icon);
  return (
    <button
      type="button"
      class="wallet-row"
      disabled={disabled}
      onClick={() => onPick(wallet.name)}
    >
      {icon === undefined ? (
        <span class="monogram" aria-hidden="true">
          {(Array.from(wallet.name)[0] ?? '?').toUpperCase()}
        </span>
      ) : (
        <img class="wallet-icon" src={icon} alt="" aria-hidden="true" />
      )}
      <span class="wallet-name">
        {wallet.name}
        {tempo ? <span class="wallet-note">switches to Tempo</span> : null}
      </span>
      <span class="chevron" aria-hidden="true" />
    </button>
  );
}
