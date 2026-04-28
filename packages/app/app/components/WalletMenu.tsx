import { USDC_SOLANA_DEVNET } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import Decimal from 'decimal.js-light';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useIdentity } from '~/hooks/useIdentity';
import { useWalletBalances } from '~/hooks/useWalletBalances';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { MarbleAvatar } from './MarbleAvatar';

const IDENTITY_AVATAR_PX = 32;
const COPY_FEEDBACK_MS = 1400;
const SOL_DISPLAY_DECIMALS = 4;
const USDC_DISPLAY_DECIMALS = 2;

type CopyKey = 'identity' | 'wallet';

interface Props {
  address: string;
  isClosing: boolean;
  onClose: () => void;
  onAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}

function truncateMiddle(value: string, prefix = 4, suffix = 4) {
  if (value.length <= prefix + suffix + 1) {
    return value;
  }
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

interface CopyRowProps {
  label: string;
  display: string;
  icon: React.ReactNode;
  copied: boolean;
  onCopy: () => void;
}

function CopyRow({ label, display, icon, copied, onCopy }: CopyRowProps) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy ${label.toLowerCase()}`}
      className="group flex w-full min-w-0 items-center gap-12 border-0 bg-transparent px-20 py-14 text-left transition-colors hover:bg-black/[0.025]"
    >
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
          {label}
        </span>
        <span className="mt-2 truncate font-mono text-[13px] font-medium text-text">{display}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'flex size-28 shrink-0 items-center justify-center rounded-full transition-all',
          copied
            ? 'bg-green/10 text-green'
            : 'text-text-2/60 group-hover:bg-black/5 group-hover:text-text',
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      className="size-14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2.5" ry="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="size-14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

interface BalanceCellProps {
  amount: string | null;
  symbol: string;
  icon: React.ReactNode;
  isLoading: boolean;
}

function BalanceCell({ amount, symbol, icon, isLoading }: BalanceCellProps) {
  if (isLoading) {
    return (
      <div className="flex h-28 items-center justify-center">
        <div className="skeleton h-22 w-96 rounded-6" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-7 tabular-nums">
      <span className="truncate text-[24px] leading-none font-semibold tracking-[-0.02em] text-text">
        {amount ?? '0'}
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

function WalletGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-16 text-text-2"
    >
      <rect x="2.5" y="6" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <circle cx="17" cy="15" r="1.3" fill="currentColor" />
    </svg>
  );
}

export function WalletMenu({ address, isClosing, onClose, onAnimationEnd }: Props) {
  const { disconnect } = useWallet();
  const { npub, publicKey: nostrPubkey } = useIdentity();
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

  const { solLamports, usdcRaw, isSolLoading, isUsdcLoading } = useWalletBalances();
  const solBalance =
    solLamports === null
      ? null
      : new Decimal(solLamports.toString())
          .div(1e9)
          .toDecimalPlaces(SOL_DISPLAY_DECIMALS)
          .toString();
  const usdcBalance =
    usdcRaw === null
      ? null
      : new Decimal(usdcRaw.toString())
          .div(new Decimal(10).pow(USDC_SOLANA_DEVNET.decimals))
          .toDecimalPlaces(USDC_DISPLAY_DECIMALS)
          .toString();

  async function handleCopy(key: CopyKey, value: string, toastText: string) {
    await navigator.clipboard.writeText(value);
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
    track('wallet-disconnect');
    await disconnect();
    onClose();
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
      <div className="px-20 pt-26 pb-22">
        <div className="flex items-center justify-center gap-10">
          <span className="text-[10px] font-semibold tracking-[0.14em] text-text-2/80 uppercase">
            Balance
          </span>
          <span className="rounded-12 bg-stat-indigo-bg px-8 py-5 font-mono text-[10px] leading-none font-medium tracking-wide text-stat-indigo uppercase">
            Devnet
          </span>
        </div>
        <div className="mt-14 grid grid-cols-2 items-center divide-x divide-black/5">
          <BalanceCell
            amount={solBalance ?? null}
            symbol="SOL"
            icon={<SolMark className="size-14" />}
            isLoading={isSolLoading}
          />
          <BalanceCell
            amount={usdcBalance ?? null}
            symbol="USDC"
            icon={<UsdcMark className="size-18" />}
            isLoading={isUsdcLoading}
          />
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
