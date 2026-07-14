import { truncateKey } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useIdentity } from '~/hooks/useIdentity';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { ConnectMenu } from './ConnectMenu';
import { truncateMiddle } from './CopyRow';
import { MarbleAvatar } from './MarbleAvatar';
import { MessagesNavLink } from './MessagesNavLink';
import { ProviderKeyDialog } from './ProviderKeyDialog';
import { ProviderMenu } from './ProviderMenu';
import { WalletGlyph } from './WalletGlyph';
import { WalletMenu } from './WalletMenu';

export function Header() {
  const { publicKey } = useWallet();
  const { providerSession, npub, publicKey: nostrPubkey } = useIdentity();
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [providerKeyOpen, setProviderKeyOpen] = useState(false);
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

  // When the wallet disconnects the menu unmounts immediately, but the
  // closing animation state would otherwise stick around and replay on the
  // next pill mount (briefly flashing the dropdown-out animation). Layout
  // effect, not passive: the reset must land before paint, or the provider
  // pill's menu could flash for a frame on wallet logout. Gated on !address
  // so a provider-key logout from inside a still-open WalletMenu does not
  // snap that menu shut without animation.
  useLayoutEffect(() => {
    if (!address) {
      setMenuOpen(false);
      setMenuClosing(false);
    }
  }, [address, providerSession]);

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

  function openProviderSignIn() {
    setProviderKeyOpen(true);
  }

  const pillBase =
    'inline-flex shrink-0 items-center gap-6 rounded-12 border px-12 py-8 text-xs font-medium whitespace-nowrap no-underline transition-colors sm:px-16';
  const pillVariant = dark
    ? 'bg-white/8 border-white/8 text-white hover:bg-white/10'
    : 'bg-transparent border-black/15 text-surface-dark hover:bg-black/4';
  const accountPillClass = cn(
    'flex shrink-0 cursor-pointer items-center gap-8 rounded-12 border px-12 py-8 transition-colors',
    dark
      ? 'border-white/8 bg-white/8 hover:bg-white/10'
      : 'border-black/15 bg-transparent hover:bg-black/4',
  );

  function handleMenuAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (menuClosing) {
      setMenuClosing(false);
    }
  }

  // Exactly one of three account states renders: wallet pill, provider pill,
  // or the Connect button.
  let accountNode: ReactNode;
  if (display && address) {
    accountNode = (
      <div className="relative" ref={menuContainerRef}>
        <button
          type="button"
          onClick={toggleMenu}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className={accountPillClass}
        >
          <WalletGlyph className={cn('size-14', dark ? 'text-white' : 'text-surface-dark')} />
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
            onAnimationEnd={handleMenuAnimationEnd}
          />
        )}
      </div>
    );
  } else if (providerSession) {
    accountNode = (
      <div className="relative" ref={menuContainerRef}>
        <button
          type="button"
          onClick={toggleMenu}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className={accountPillClass}
        >
          <span className="size-16 shrink-0 overflow-hidden rounded-full">
            <MarbleAvatar name={nostrPubkey} size={16} />
          </span>
          <span
            className={cn(
              'font-mono text-xs font-medium max-xs:hidden',
              dark ? 'text-white' : 'text-surface-dark',
            )}
          >
            {truncateMiddle(npub, 6, 4)}
          </span>
        </button>
        {(menuOpen || menuClosing) && (
          <ProviderMenu
            isClosing={menuClosing}
            onClose={startClose}
            onAnimationEnd={handleMenuAnimationEnd}
          />
        )}
      </div>
    );
  } else {
    accountNode = (
      <div className="relative" ref={menuContainerRef}>
        <button
          type="button"
          onClick={toggleMenu}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className={cn(
            pillBase,
            'cursor-pointer border-transparent',
            dark
              ? 'bg-white text-surface-dark hover:bg-white/90'
              : 'bg-surface-dark text-white hover:bg-accent-hover',
          )}
        >
          Connect
        </button>
        {(menuOpen || menuClosing) && (
          <ConnectMenu
            isClosing={menuClosing}
            onClose={startClose}
            onSignInAsProvider={openProviderSignIn}
            onAnimationEnd={handleMenuAnimationEnd}
          />
        )}
      </div>
    );
  }

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
              href="https://docs.elisym.network/providers/quickstart"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('cta-run-agent')}
              className={cn(pillBase, pillVariant, 'shrink-0 whitespace-nowrap')}
            >
              <span className="sm:hidden">Run Agent</span>
              <span className="hidden sm:inline">Run AI Agent</span>
            </a>

            {/* Messages are gated behind a wallet OR provider session;
                unmounting also stops the live DM subscription for
                signed-out visitors. */}
            {(address || providerSession) && <MessagesNavLink dark={dark} />}

            {accountNode}
          </div>
        </nav>
      </div>
      {providerKeyOpen && <ProviderKeyDialog onClose={() => setProviderKeyOpen(false)} />}
    </header>
  );
}
