import { useWallet } from '@solana/wallet-adapter-react';
import { Suspense, lazy } from 'react';
import { Link, useLocation } from 'wouter';
import { NostrKeys } from '~/components/NostrKeys';
import { ProfileCard } from '~/components/ProfileCard';
import { useIdentity } from '~/hooks/useIdentity';
import { track } from '~/lib/analytics';

const OrderHistory = lazy(() =>
  import('~/components/OrderHistory').then((m) => ({ default: m.OrderHistory })),
);

function SectionSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-border bg-surface p-32">
      <div className="mb-16 h-16 w-128 rounded bg-[#f0f0ee]" />
      <div className="h-12 w-192 rounded bg-[#f0f0ee]" />
    </div>
  );
}

export default function Profile() {
  const { npub, publicKey: nostrPubkey, allIdentities, activeId } = useIdentity();
  const { disconnect } = useWallet();
  const [, setLocation] = useLocation();
  const activeKeyName = allIdentities.find((e) => e.id === activeId)?.name;

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-24 px-24 py-40">
      <Link
        to="/"
        className="inline-flex items-center gap-6 text-sm font-medium text-text-2 no-underline transition-colors hover:text-text"
      >
        <svg
          width="16"
          height="16"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to Marketplace
      </Link>

      <ProfileCard npub={npub} pubkey={nostrPubkey} keyName={activeKeyName} />

      <Suspense fallback={<SectionSkeleton />}>
        <OrderHistory />
      </Suspense>

      <NostrKeys />

      <div className="rounded-2xl border border-border bg-surface p-24">
        <button
          onClick={async () => {
            track('wallet-disconnect');
            await disconnect();
            setLocation('/');
          }}
          className="flex w-full cursor-pointer items-center justify-center gap-8 rounded-xl border border-error/20 bg-error/5 py-12 text-sm font-medium text-error transition-colors hover:bg-error/10"
        >
          <svg
            width="16"
            height="16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
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
