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
    <div className="bg-surface border border-border rounded-2xl p-8 animate-pulse">
      <div className="h-4 w-32 bg-[#f0f0ee] rounded mb-4" />
      <div className="h-3 w-48 bg-[#f0f0ee] rounded" />
    </div>
  );
}

export default function Profile() {
  const { npub, publicKey: nostrPubkey, allIdentities, activeId } = useIdentity();
  const { disconnect } = useWallet();
  const [, setLocation] = useLocation();
  const activeKeyName = allIdentities.find((e) => e.id === activeId)?.name;

  return (
    <div className="max-w-[800px] mx-auto py-10 px-6 flex flex-col gap-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-text-2 no-underline text-sm font-medium transition-colors hover:text-text"
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

      <div className="bg-surface border border-border rounded-2xl p-6">
        <button
          onClick={async () => {
            track('wallet-disconnect');
            await disconnect();
            setLocation('/');
          }}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-error/20 bg-error/5 text-error text-sm font-medium cursor-pointer hover:bg-error/10 transition-colors"
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
