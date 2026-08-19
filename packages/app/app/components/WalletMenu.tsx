import { assetKey, type Asset } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import Decimal from 'decimal.js-light';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useIdentity } from '~/hooks/useIdentity';
import { purgeIdentityCaches } from '~/hooks/useMessages';
import { SPL_WALLET_ASSETS, useWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { DEVNET_APP_URL, SOLANA_CLUSTER, SOLANA_CLUSTER_LABEL } from '~/lib/cluster';
import { cn } from '~/lib/cn';
import { CopyRow, truncateMiddle } from './CopyRow';
import { LsmIcon } from './LsmIcon';
import { MarbleAvatar } from './MarbleAvatar';
import { WalletGlyph } from './WalletGlyph';

const IDENTITY_AVATAR_PX = 32;
const COPY_FEEDBACK_MS = 1400;
const SOL_DISPLAY_DECIMALS = 4;
const SPL_DISPLAY_DECIMALS = 2;

type CopyKey = 'identity' | 'wallet';

interface Props {
  address: string;
  isClosing: boolean;
  onClose: () => void;
  onAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}

interface BalanceCellProps {
  amount: string | null;
  symbol: string;
  icon: React.ReactNode;
  isLoading: boolean;
  /** The balance could not be read - shown as unknown, never as zero. */
  isUnavailable?: boolean;
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

function BalanceCell({ amount, symbol, icon, isLoading, isUnavailable }: BalanceCellProps) {
  if (isLoading) {
    return (
      <div className="flex h-28 items-center justify-center">
        <div className="skeleton h-22 w-96 rounded-6" />
      </div>
    );
  }
  return (
    <div className="flex h-28 items-center justify-center gap-7 tabular-nums">
      <span
        className="truncate text-[24px] leading-none font-semibold tracking-[-0.02em] text-text"
        title={isUnavailable ? `${symbol} balance could not be read` : undefined}
      >
        {isUnavailable ? '-' : (amount ?? '0')}
      </span>
      {icon}
      <span className="sr-only">{symbol}</span>
    </div>
  );
}

function SolMark({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg aria-hidden viewBox="0 0 397.7 311.7" className={cn('size-16 shrink-0', className)}>
      <linearGradient
        id={gradientId}
        gradientUnits="userSpaceOnUse"
        x1="360.88"
        y1="351.46"
        x2="141.21"
        y2="-69.29"
        gradientTransform="matrix(1 0 0 -1 0 314)"
      >
        <stop offset="0" stopColor="#00ffa3" />
        <stop offset="1" stopColor="#dc1fff" />
      </linearGradient>
      <path
        fill={`url(#${gradientId})`}
        d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"
      />
    </svg>
  );
}

function UsdcMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 2000 2000" className={cn('size-16 shrink-0', className)}>
      <path
        fill="#2775CA"
        d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
      />
      <path
        fill="white"
        d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.67-125-16.67-150-50-150-108.33s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.67c16.67 0 29.17-12.5 29.17-29.17v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.33h-62.5c-16.67 0-29.17 12.5-33.33 33.33v95.83c-125 16.67-204.17 100-204.17 204.17 0 137.5 83.33 191.67 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.33 112.5-137.5 112.5c-108.33 0-145.83-45.83-158.33-108.33-4.17-16.67-16.67-25-29.17-25h-70.83c-16.67 0-29.17 12.5-29.17 29.17v4.17c16.67 104.17 83.33 179.17 220.83 200v100c0 16.67 12.5 29.17 33.33 33.33h62.5c16.67 0 29.17-12.5 33.33-33.33v-100c125-20.83 208.33-108.33 208.33-220.83z"
      />
      <path
        fill="white"
        d="M787.5 1595.83c-325-116.67-491.67-479.17-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67v-58.33c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.17-395.83 125-612.5 545.83-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.33 0 37.5-16.67 4.17-4.17 4.17-8.33 4.17-16.67v-58.33c0-12.5-12.5-29.17-25-37.5zM1229.17 295.83c-16.67-8.33-33.33 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.67 491.67 479.17 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67v58.33c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.17 395.83-125 612.5-545.83 487.5-941.67-75-237.5-258.33-416.67-487.5-491.67z"
      />
    </svg>
  );
}

/**
 * Per-asset mark for a balance row. LSM has no brand artwork yet, so it renders
 * the shared placeholder from `LsmIcon` rather than a second local copy - one
 * token must not read as two different assets across the app.
 */
function SplMark({ asset, className }: { asset: Asset; className?: string }) {
  if (asset.token === 'usdc') {
    return <UsdcMark className={className} />;
  }
  if (asset.token === 'lsm') {
    return <LsmIcon className={cn('shrink-0', className)} />;
  }
  return <WalletGlyph className={className} />;
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

  const { solLamports, splRaw, isSolLoading, isSolError, isSplLoadingByAsset, isSplErrorByAsset } =
    useWalletBalances();
  const solBalance =
    solLamports === null
      ? null
      : new Decimal(solLamports.toString())
          .div(1e9)
          .toDecimalPlaces(SOL_DISPLAY_DECIMALS)
          .toString();
  const splBalanceFor = (asset: Asset): string | null => {
    const raw = splRaw[assetKey(asset)] ?? null;
    if (raw === null) {
      return null;
    }
    return new Decimal(raw.toString())
      .div(new Decimal(10).pow(asset.decimals))
      .toDecimalPlaces(SPL_DISPLAY_DECIMALS)
      .toString();
  };

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
      <div className="px-20 pt-26 pb-22">
        <div className="flex items-center justify-center gap-10">
          <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
            Balance
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
        <div
          className={cn(
            'mt-14 grid items-center',
            // Two balances fit side by side in the 280px menu; beyond that a
            // column is too narrow for the 24px figure and truncates it (a
            // seven-figure LSM balance worst of all), so stack them as rows.
            // Row form takes any number of assets - the column form does not.
            SPL_WALLET_ASSETS.length > 1
              ? 'grid-cols-1 divide-y divide-black/5'
              : 'grid-cols-2 divide-x divide-black/5',
          )}
        >
          <BalanceCell
            amount={solBalance ?? null}
            symbol="SOL"
            icon={<SolMark className="size-14" />}
            isLoading={isSolLoading}
            isUnavailable={isSolError}
          />
          {SPL_WALLET_ASSETS.map((asset) => (
            <BalanceCell
              key={assetKey(asset)}
              amount={splBalanceFor(asset)}
              symbol={asset.symbol}
              icon={<SplMark asset={asset} className="size-18" />}
              isLoading={isSplLoadingByAsset[assetKey(asset)] ?? false}
              isUnavailable={isSplErrorByAsset[assetKey(asset)] ?? false}
            />
          ))}
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
