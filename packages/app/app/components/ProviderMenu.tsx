import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useIdentity } from '~/hooks/useIdentity';
import { purgeIdentityCaches } from '~/hooks/useMessages';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { CopyRow, truncateMiddle } from './CopyRow';
import { MarbleAvatar } from './MarbleAvatar';

const IDENTITY_AVATAR_PX = 32;
const COPY_FEEDBACK_MS = 1400;

interface Props {
  isClosing: boolean;
  onClose: () => void;
  onAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}

/** Header dropdown for a wallet-less provider session (imported Nostr key). */
export function ProviderMenu({ isClosing, onClose, onAnimationEnd }: Props) {
  const { npub, publicKey, logoutProvider } = useIdentity();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(npub);
    } catch {
      toast.error('Could not copy npub');
      return;
    }
    toast.success('Npub copied');
    setCopied(true);
    if (copyTimeoutRef.current !== null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  async function handleLogout() {
    // Close first: a later close would re-arm menuClosing via the header's
    // stale-closure location effect after the layout reset already ran.
    onClose();
    track('provider-disconnect');
    // The plaintext purge must commit before the key entry is removed - a
    // fire-and-forget purge lets a tab close strand decrypted DMs in
    // IndexedDB with the key already gone (see purgeIdentityCaches).
    await purgeIdentityCaches(queryClient, publicKey);
    logoutProvider();
    setLocation('/');
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
      <div className="px-20 pt-20 pb-6">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
          Provider session
        </span>
      </div>

      <div className="pb-8">
        <CopyRow
          label="Identity"
          display={truncateMiddle(npub, 6, 4)}
          copied={copied}
          onCopy={() => void handleCopy()}
          icon={
            <span className="size-32 overflow-hidden rounded-full ring-1 ring-black/5">
              <MarbleAvatar name={publicKey} size={IDENTITY_AVATAR_PX} />
            </span>
          }
        />
      </div>

      <div className="mx-20 h-px bg-black/5" />

      <div className="p-10">
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
