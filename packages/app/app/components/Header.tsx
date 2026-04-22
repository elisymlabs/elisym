import { truncateKey } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Link, useLocation } from 'wouter';
import { track } from '~/lib/analytics';
import { MarbleAvatar } from './MarbleAvatar';

export function Header() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [location] = useLocation();

  const dark = location === '/';

  const address = publicKey?.toBase58();
  const display = address ? truncateKey(address, 4) : null;

  function handleSignIn() {
    track('wallet-connect');
    setVisible(true);
  }

  return (
    <header className="relative z-10">
      <div className="px-4 sm:px-6 lg:px-8">
        <nav className="flex items-center justify-between" style={{ padding: '18px 0' }}>
          <Link to="/">
            <img
              src={dark ? '/logo.png' : '/logo-black.png'}
              alt="elisym"
              style={{ height: '24px' }}
            />
          </Link>

          <div className="flex items-center gap-2">
            <a
              href="https://github.com/elisymlabs/elisym-client/blob/main/GUIDE.md"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('cta-run-agent')}
              className="no-underline"
              style={{
                fontSize: '13px',
                fontWeight: 500,
                padding: '8px 16px',
                borderRadius: '12px',
                background: dark ? 'rgba(255,255,255,0.08)' : 'transparent',
                border: dark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.15)',
                color: dark ? 'white' : '#101012',
              }}
            >
              Run AI Agent
            </a>

            {display ? (
              <Link
                to="/profile"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '5px 12px 5px 5px',
                  borderRadius: '12px',
                  textDecoration: 'none',
                  border: dark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.15)',
                  background: dark ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
              >
                <div style={{ width: 26, height: 26, borderRadius: '50%', overflow: 'hidden' }}>
                  <MarbleAvatar name={display} size={26} />
                </div>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    fontWeight: 500,
                    color: dark ? 'white' : '#101012',
                  }}
                >
                  {display}
                </span>
              </Link>
            ) : (
              <button
                onClick={() => void handleSignIn()}
                className="cursor-pointer"
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  padding: '8px 16px',
                  borderRadius: '12px',
                  background: dark ? '#ffffff' : '#101012',
                  color: dark ? '#101012' : 'white',
                  border: '1px solid transparent',
                }}
              >
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
