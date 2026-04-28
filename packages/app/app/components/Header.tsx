import { truncateKey } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { WalletGlyph } from './WalletGlyph';
import { WalletMenu } from './WalletMenu';

export function Header() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  const dark = location === '/';

  const address = publicKey?.toBase58();
  const display = address ? truncateKey(address, 4) : null;
  const displayShort = address ? truncateKey(address, 2) : null;

  function startClose() {
    setMenuOpen(false);
    setMenuClosing(true);
  }

  function toggleMenu() {
    if (menuOpen) {
      startClose();
    } else {
      setMenuClosing(false);
      setMenuOpen(true);
    }
  }

  useEffect(() => {
    if (menuOpen) {
      startClose();
    }
    // location change should close the menu; ignore other deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // When the wallet disconnects the WalletMenu unmounts immediately, but the
  // closing animation state would otherwise stick around and replay on the
  // next connect (briefly flashing the dropdown-out animation). Reset both
  // flags so reconnect mounts a fresh, idle menu.
  useEffect(() => {
    if (!address) {
      setMenuOpen(false);
      setMenuClosing(false);
    }
  }, [address]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function handleClickOutside(event: MouseEvent) {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        startClose();
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        startClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  function handleSignIn() {
    track('wallet-connect');
    setVisible(true);
  }

  const pillBase =
    'inline-flex shrink-0 items-center gap-6 rounded-12 border px-12 py-8 text-xs font-medium whitespace-nowrap no-underline transition-colors sm:px-16';
  const pillVariant = dark
    ? 'bg-white/8 border-white/8 text-white hover:bg-white/10'
    : 'bg-transparent border-black/15 text-surface-dark hover:bg-black/4';

  return (
    <header className="relative z-10">
      <div className="px-12 sm:px-24 lg:px-32">
        <nav className="flex items-center justify-between gap-8 py-14 sm:py-18">
          <Link to="/" className="shrink-0">
            <img
              src={dark ? '/logo.png' : '/logo-black.png'}
              alt="elisym"
              className="h-24 max-xs:h-20"
            />
          </Link>

          <div className="flex min-w-0 items-center gap-6 sm:gap-8">
            <a
              href="https://github.com/elisymlabs/elisym/blob/main/packages/cli/GUIDE.md"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('cta-run-agent')}
              className={cn(pillBase, pillVariant, 'shrink-0 whitespace-nowrap')}
            >
              <span className="sm:hidden">Run Agent</span>
              <span className="hidden sm:inline">Run AI Agent</span>
            </a>

            {display && address ? (
              <div className="relative" ref={menuContainerRef}>
                <button
                  type="button"
                  onClick={toggleMenu}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  className={cn(
                    'flex shrink-0 cursor-pointer items-center gap-8 rounded-12 border px-12 py-8 transition-colors',
                    dark
                      ? 'border-white/8 bg-white/8 hover:bg-white/10'
                      : 'border-black/15 bg-transparent hover:bg-black/4',
                  )}
                >
                  <WalletGlyph
                    className={cn('size-14', dark ? 'text-white' : 'text-surface-dark')}
                  />
                  <span
                    className={cn(
                      'font-mono text-xs font-medium',
                      dark ? 'text-white' : 'text-surface-dark',
                    )}
                  >
                    <span className="max-xs:hidden">{display}</span>
                    <span className="hidden max-xs:inline">{displayShort}</span>
                  </span>
                </button>
                {(menuOpen || menuClosing) && (
                  <WalletMenu
                    address={address}
                    isClosing={menuClosing}
                    onClose={startClose}
                    onAnimationEnd={(event) => {
                      if (event.target !== event.currentTarget) {
                        return;
                      }
                      if (menuClosing) {
                        setMenuClosing(false);
                      }
                    }}
                  />
                )}
              </div>
            ) : (
              <button
                onClick={() => void handleSignIn()}
                className={cn(
                  pillBase,
                  'cursor-pointer border-transparent',
                  dark
                    ? 'bg-white text-surface-dark hover:bg-white/90'
                    : 'bg-surface-dark text-white hover:bg-accent-hover',
                )}
              >
                <span className="sm:hidden">Connect</span>
                <span className="hidden sm:inline">Connect Wallet</span>
              </button>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
