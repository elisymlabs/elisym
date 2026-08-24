import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useIdentity } from '~/hooks/useIdentity';
import { purgeIdentityCaches } from '~/hooks/useMessages';
import { track } from '~/lib/analytics';
import { DEVNET_APP_URL, SOLANA_CLUSTER, SOLANA_CLUSTER_LABEL } from '~/lib/cluster';
import { cn } from '~/lib/cn';
import { CopyRow, truncateMiddle } from './CopyRow';
import { MarbleAvatar } from './MarbleAvatar';
import { WalletGlyph } from './WalletGlyph';

const IDENTITY_AVATAR_PX = 32;
const COPY_FEEDBACK_MS = 1400;

type CopyKey = 'identity' | 'wallet';

interface Props {
  address: string;
  isClosing: boolean;
  onClose: () => void;
  onAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}

function KeyGlyph() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

export function WalletMenu({ address, isClosing, onClose, onAnimationEnd }: Props) {
  const { disconnect } = useWallet();
  const { npub, publicKey: nostrPubkey, providerSession, logoutProvider } = useIdentity();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [copiedKey, setCopiedKey] = useState<CopyKey | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy(key: CopyKey, value: string, toastText: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error('Could not copy');
      return;
    }
    toast.success(toastText);
    setCopiedKey(key);
    if (copyTimeoutRef.current !== null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopiedKey(null);
      copyTimeoutRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  async function handleLogout() {
    // Close BEFORE the await: the adapter's publicKey can flip to null in its
    // own commit mid-await, and a continuation-side close would re-arm
    // menuClosing after the header's reset already ran - the next pill mount
    // would then replay a phantom dropdown-out.
    onClose();
    track('wallet-disconnect');
    await disconnect();
    setLocation('/');
  }

  async function handleProviderLogout() {
    track('provider-disconnect');
    // The plaintext purge must commit before the key entry is removed - a
    // fire-and-forget purge lets a tab close strand decrypted DMs in
    // IndexedDB with the key already gone (see purgeIdentityCaches).
    await purgeIdentityCaches(queryClient, nostrPubkey);
    logoutProvider();
    // No onClose/navigation: the wallet stays connected and the menu stays
    // open - the Identity row above simply swaps back to the generated key.
  }

  return (
    <div
      onAnimationEnd={onAnimationEnd}
      className={cn(
        'absolute top-full right-0 z-20 mt-10 w-[min(320px,calc(100vw-24px))] overflow-hidden rounded-3xl border border-black/8 bg-surface text-text',
        'shadow-[0_24px_48px_-16px_rgba(16,16,32,0.18),0_2px_8px_rgba(16,16,32,0.05)]',
        isClosing ? 'dropdown-out' : 'dropdown-in',
      )}
    >
      {/* Network, not balances. The affordability gate on the agent page is
          the only place these numbers decide anything, and it reads them
          itself - so the menu no longer carries a balance poll of its own. */}
      <div className="px-20 pt-22 pb-18">
        <div className="flex items-center justify-center gap-10">
          <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
            Network
          </span>
          <span className="rounded-12 bg-stat-indigo-bg px-8 py-5 font-mono text-[10px] leading-none font-medium tracking-wide text-stat-indigo uppercase">
            {SOLANA_CLUSTER_LABEL}
          </span>
          {SOLANA_CLUSTER === 'mainnet' && (
            <a
              href={DEVNET_APP_URL}
              className="font-mono text-[10px] leading-none tracking-wide text-text-2/70 underline transition-colors hover:text-text-2"
            >
              Devnet
            </a>
          )}
        </div>
      </div>

      <div className="mx-20 h-px bg-black/5" />

      <div className="py-8">
        <CopyRow
          label="Identity"
          display={truncateMiddle(npub, 6, 4)}
          copied={copiedKey === 'identity'}
          onCopy={() => void handleCopy('identity', npub, 'Npub copied')}
          icon={
            <span className="size-32 overflow-hidden rounded-full ring-1 ring-black/5">
              <MarbleAvatar name={nostrPubkey} size={IDENTITY_AVATAR_PX} />
            </span>
          }
        />
        <CopyRow
          label="Wallet"
          display={truncateMiddle(address, 6, 4)}
          copied={copiedKey === 'wallet'}
          onCopy={() => void handleCopy('wallet', address, 'Address copied')}
          icon={
            <span className="flex size-32 items-center justify-center rounded-full bg-surface-2 ring-1 ring-black/5">
              <WalletGlyph />
            </span>
          }
        />
      </div>

      <div className="mx-20 h-px bg-black/5" />

      <div className="p-10">
        {providerSession && (
          <button
            type="button"
            onClick={() => void handleProviderLogout()}
            className="group inline-flex w-full cursor-pointer items-center justify-center gap-8 rounded-12 bg-transparent px-16 py-10 text-[13px] font-medium text-text-2 transition-colors hover:bg-black/5 hover:text-text"
          >
            <KeyGlyph />
            Log out provider key
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="group inline-flex w-full cursor-pointer items-center justify-center gap-8 rounded-12 bg-transparent px-16 py-10 text-[13px] font-medium text-text-2 transition-colors hover:bg-black/5 hover:text-text"
        >
          <svg
            aria-hidden
            width="14"
            height="14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-colors"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Log out
        </button>
      </div>
    </div>
  );
}
