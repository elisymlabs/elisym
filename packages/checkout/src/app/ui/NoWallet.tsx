import type { Rail } from '../session';

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
};

/** No wallet in this browser can pay on this network. */
export function NoWallet({ chain, phone }: Props) {
  if (phone) {
    return (
      <div class="empty">
        <p>No wallet found in this browser.</p>
        <p>Open this page in your wallet app’s browser.</p>
      </div>
    );
  }
  return (
    <div class="empty">
      <p>No wallet for this network found in this browser. Install one:</p>
      <ul class="install">
        {INSTALL[chain].map((wallet) => (
          <li key={wallet.name}>
            <a href={wallet.url} target="_blank" rel="noopener noreferrer">
              {wallet.name}
            </a>
          </li>
        ))}
      </ul>
      {chain === 'tempo' ? <p>MetaMask is known to work.</p> : null}
      <p class="note">Reload this page after installing.</p>
    </div>
  );
}
