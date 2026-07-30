import { useWallet } from '@solana/wallet-adapter-react';
import { Link } from 'wouter';
import { useUnseenJobsCount } from '~/hooks/useJobHistory';
import { cn } from '~/lib/cn';

interface Props {
  dark: boolean;
}

/**
 * Header entry point for the global job history (/jobs). The badge counts
 * `unseen` terminal flips - results that landed while the user was not
 * looking - from the shared job-history store.
 */
export function JobsNavLink({ dark }: Props) {
  const { publicKey } = useWallet();
  const unseen = useUnseenJobsCount(publicKey?.toBase58() ?? '');

  return (
    <Link
      to="/jobs"
      aria-label={unseen > 0 ? `Jobs, ${unseen} new results` : 'Jobs'}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-12 border p-8 no-underline transition-colors sm:px-10',
        dark
          ? 'border-white/8 bg-white/8 text-white hover:bg-white/10'
          : 'border-black/15 bg-transparent text-surface-dark hover:bg-black/4',
      )}
    >
      <svg
        aria-hidden
        className="size-16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
      {unseen > 0 && (
        <span className="absolute -top-6 -right-6 inline-flex h-16 min-w-16 items-center justify-center rounded-full bg-accent px-4 text-[10px] font-semibold text-white">
          {unseen > 99 ? '99+' : unseen}
        </span>
      )}
    </Link>
  );
}
