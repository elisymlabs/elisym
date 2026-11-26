import { useEffect, useState } from 'react';
import { type WalletChoice, type WalletFamily, watchWallets } from '../lib/wallets';
import { BUTTON_SECONDARY } from '../styles';

interface Props {
  family: WalletFamily;
  disabled: boolean;
  onPick: (wallet: WalletChoice) => void;
}

const FAMILY_NAMES: Readonly<Record<WalletFamily, string>> = {
  solana: 'Solana',
  evm: 'EVM',
};

/** "Sign with <wallet>" for each wallet of `family` this browser has. */
export function WalletPicker({ family, disabled, onPick }: Props) {
  const [wallets, setWallets] = useState<WalletChoice[]>([]);

  useEffect(() => watchWallets(family, setWallets), [family]);

  if (wallets.length === 0) {
    return (
      <p className="text-13 text-text-2">
        No {FAMILY_NAMES[family]} wallet found in this browser. Open this page in a browser with
        your wallet extension.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-8">
      {wallets.map((wallet) => (
        <button
          key={wallet.id}
          type="button"
          className={BUTTON_SECONDARY}
          disabled={disabled}
          onClick={() => onPick(wallet)}
        >
          Sign with {wallet.name}
        </button>
      ))}
    </div>
  );
}
