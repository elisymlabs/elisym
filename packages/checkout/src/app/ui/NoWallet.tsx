import type { Rail } from '../session';
import { WALLET_BRAND_ICONS } from './wallet-brand-icons';

interface Props {
  chain: Rail;
  phone: boolean;
}

const INSTALL: Record<Rail, { name: string; url: string }[]> = {
  solana: [
    { name: 'Phantom', url: 'https://phantom.com/download' },
    { name: 'Solflare', url: 'https://solflare.com/download' },
  ],
  tempo: [{ name: 'MetaMask', url: 'https://metamask.io/download/' }],
  eip3009: [
    { name: 'MetaMask', url: 'https://metamask.io/download/' },
    { name: 'Rabby', url: 'https://rabby.io/' },
  ],
};

/** No wallet in this browser can pay on this network. */
export function NoWallet({ chain, phone }: Props) {
  if (phone) {
    return (
      <div class="empty no-wallet">
        <p>No wallet found in this browser.</p>
        <p>
          {chain === 'solana'
            ? 'Open this page in your wallet app’s browser.'
            : 'Open this page in MetaMask’s in-app browser.'}
        </p>
      </div>
    );
  }
  return (
    <div class="empty no-wallet">
      <p>
        No wallet for this network found in this browser
        <br />
        Install one to continue
      </p>
      <ul class="install">
        {INSTALL[chain].map((wallet) => (
          <li key={wallet.name}>
            <a class="secondary" href={wallet.url} target="_blank" rel="noopener noreferrer">
              {WALLET_BRAND_ICONS[wallet.name] ? (
                <img src={WALLET_BRAND_ICONS[wallet.name]} alt="" width="24" height="24" />
              ) : null}
              {wallet.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
