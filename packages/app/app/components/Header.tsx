import { truncateKey } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Link, useLocation } from 'wouter';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { MarbleAvatar } from './MarbleAvatar';

const AVATAR_SIZE = 26;

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

  const pillBase =
    'inline-flex items-center rounded-12 px-16 py-8 text-[13px] font-medium no-underline transition-colors';
  const pillVariant = dark
    ? 'bg-white/8 border border-white/8 text-white hover:bg-white/12'
    : 'bg-transparent border border-black/15 text-surface-dark hover:bg-black/5';

  return (
    <header className="relative z-10">
      <div className="px-16 sm:px-24 lg:px-32">
        <nav className="flex items-center justify-between py-18">
          <Link to="/">
            <img src={dark ? '/logo.png' : '/logo-black.png'} alt="elisym" className="h-24" />
          </Link>

          <div className="flex items-center gap-8">
            <a
              href="https://github.com/elisymlabs/elisym-client/blob/main/GUIDE.md"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('cta-run-agent')}
              className={cn(pillBase, pillVariant)}
            >
              Run AI Agent
            </a>

            {display ? (
              <Link
                to="/profile"
                className={cn(
                  'flex items-center gap-8 rounded-12 border py-5 pr-12 pl-5 no-underline transition-colors',
                  dark
                    ? 'border-white/8 bg-white/8 hover:bg-white/12'
                    : 'border-black/15 bg-transparent hover:bg-black/5',
                )}
              >
                <div className="size-26 overflow-hidden rounded-full">
                  <MarbleAvatar name={display} size={AVATAR_SIZE} />
                </div>
                <span
                  className={cn(
                    'font-mono text-xs font-medium',
                    dark ? 'text-white' : 'text-surface-dark',
                  )}
                >
                  {display}
                </span>
              </Link>
            ) : (
              <button
                onClick={() => void handleSignIn()}
                className={cn(
                  'cursor-pointer rounded-12 border border-transparent px-16 py-8 text-[13px] font-medium transition-colors',
                  dark
                    ? 'bg-white text-surface-dark hover:bg-white/90'
                    : 'bg-surface-dark text-white hover:bg-accent-hover',
                )}
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
