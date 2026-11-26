import { type ReactNode, useCallback, useRef, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { errorMessage } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY, CARD } from '../styles';
import { EmbedTab } from './EmbedTab';
import { ForgetOnDevice } from './ForgetOnDevice';
import { MoveSwitching } from './MoveSwitching';
import { Notice } from './Notice';
import { OrdersTab } from './OrdersTab';
import { Overview } from './Overview';
import { PayoutsTab } from './PayoutsTab';
import { ProductsTab } from './ProductsTab';
import { SettingsTab } from './SettingsTab';

interface Props {
  session: StoreSession;
  /** The view the session opened with. */
  store: StoreView;
  onSignOut: () => void;
  /** Signed in by a move: the store's setup request to follow. */
  moveRequestId?: string;
}

type Tab = 'overview' | 'products' | 'orders' | 'payouts' | 'settings' | 'embed';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'products', label: 'Products' },
  { id: 'orders', label: 'Orders' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'settings', label: 'Settings' },
  { id: 'embed', label: 'Embed' },
];

export const READ_FAILED_KEPT = 'The page shows your store as it was last read.';

/**
 * The signed-in store, in tabs. Every change reads the store again; a read
 * that fails keeps the last view, with a warning.
 */
export function StoreShell({ session, store, onSignOut, moveRequestId }: Props) {
  const [view, setView] = useState(store);
  const [tab, setTab] = useState<Tab>('overview');
  const [warning, setWarning] = useState<string | undefined>(undefined);
  const { api } = session;

  const reads = useRef(0);

  /** Read the store again; only the newest read's answer counts (an older one may land later). */
  const reload = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    api.store().then(
      (next) => {
        if (read === reads.current) {
          setView(next);
          setWarning(undefined);
        }
      },
      (error: unknown) => {
        if (read === reads.current) {
          setWarning(`${errorMessage(error)} ${READ_FAILED_KEPT}`);
        }
      },
    );
  }, [api]);

  let content: ReactNode;
  if (tab === 'products') {
    content = <ProductsTab session={session} view={view} onChanged={reload} />;
  } else if (tab === 'orders') {
    content = <OrdersTab session={session} view={view} onChanged={reload} />;
  } else if (tab === 'embed') {
    content = <EmbedTab session={session} view={view} onChanged={reload} />;
  } else if (tab === 'payouts') {
    content = <PayoutsTab session={session} view={view} onChanged={reload} />;
  } else if (tab === 'settings') {
    content = <SettingsTab session={session} view={view} onChanged={reload} />;
  } else {
    content = <Overview session={session} view={view} onChanged={reload} />;
  }

  return (
    <AuthLayout>
      <div className={`${CARD} flex max-w-720 flex-col gap-24`}>
        <div className="flex flex-wrap items-center justify-between gap-12">
          <h1 className="text-24 font-semibold tracking-tight">
            {view.config?.name ?? 'Your store'}
          </h1>
          <button type="button" className={BUTTON_SECONDARY} onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <div role="tablist" className="border-line flex flex-wrap gap-4 border-b">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              className={`text-14 px-12 py-8 ${tab === item.id ? 'border-ink border-b-2 font-semibold' : 'text-text-2'}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {warning === undefined ? null : <Notice tone="warn">{warning}</Notice>}
        <MoveSwitching
          session={session}
          view={view}
          onChanged={reload}
          {...(moveRequestId === undefined ? {} : { requestId: moveRequestId })}
        />
        {content}
        <ForgetOnDevice owner={session.owner} />
      </div>
    </AuthLayout>
  );
}
