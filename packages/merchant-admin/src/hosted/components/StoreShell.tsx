import { alertMessage } from '../lib/errors';
import { npubOf } from '../lib/signer';
import type { Meta, StoreView } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { ForgetOnDevice } from './ForgetOnDevice';
import { Notice } from './Notice';
import { SessionMessage } from './SessionMessage';

interface Props {
  owner: string;
  store: StoreView;
  meta: Meta;
  onSignOut: () => void;
}

const STATUS_LABELS: Readonly<Record<StoreView['status'], string>> = {
  pending: 'Waiting for activation',
  active: 'Active',
  degraded: 'Active, needs attention',
  halted: 'Stopped',
  suspending: 'Being suspended',
  suspended: 'Suspended',
};

/** The signed-in store: who it is, its status and what needs attention, in fixed sentences. */
export function StoreShell({ owner, store, meta, onSignOut }: Props) {
  const network = store.config?.network;
  return (
    <SessionMessage title={store.config?.name ?? 'Your store'}>
      <dl className="text-14 grid grid-cols-[auto_1fr] gap-x-16 gap-y-8">
        <dt className="text-text-2">Status</dt>
        <dd id="store-status">{STATUS_LABELS[store.status]}</dd>
        {network === undefined ? null : (
          <>
            <dt className="text-text-2">Network</dt>
            <dd>{network}</dd>
          </>
        )}
        <dt className="text-text-2">Products</dt>
        <dd>
          up to {store.maxProducts ?? meta.pendingMaxProducts}
          {store.tier === null ? '' : ` (${store.tier})`}
        </dd>
        <dt className="text-text-2">Owner ID</dt>
        <dd className="font-mono break-all">{npubOf(owner)}</dd>
        <dt className="text-text-2">Store ID</dt>
        <dd className="font-mono break-all">{npubOf(store.storePubkey)}</dd>
      </dl>
      {store.alerts.map((kind) => (
        <Notice key={kind} tone="warn">
          {alertMessage(kind)}
        </Notice>
      ))}
      <ForgetOnDevice owner={owner} />
      <div>
        <button type="button" className={BUTTON_SECONDARY} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </SessionMessage>
  );
}
