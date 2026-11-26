import { alertMessage } from '../lib/errors';
import { npubOf } from '../lib/signer';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { AuthorizationSection } from './AuthorizationSection';
import { Checklist } from './Checklist';
import { Notice } from './Notice';
import { PayoutListSection } from './PayoutListSection';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

const STATUS_LABELS: Readonly<Record<StoreView['status'], string>> = {
  pending: 'Waiting for activation',
  active: 'Active',
  degraded: 'Active, needs attention',
  halted: 'Stopped',
  suspending: 'Being suspended',
  suspended: 'Suspended',
};

/** The store at a glance: status, plan, alerts in fixed sentences, and what is left to do. */
export function Overview({ session, view, onChanged }: Props) {
  const network = view.config?.network;
  return (
    <div className="flex flex-col gap-24">
      <dl className="text-14 grid grid-cols-[auto_1fr] gap-x-16 gap-y-8">
        <dt className="text-text-2">Status</dt>
        <dd id="store-status">{STATUS_LABELS[view.status]}</dd>
        {network === undefined ? null : (
          <>
            <dt className="text-text-2">Network</dt>
            <dd>{network}</dd>
          </>
        )}
        <dt className="text-text-2">Plan</dt>
        <dd id="store-plan">
          {view.tier ?? 'none yet'}, up to {view.maxProducts ?? session.meta.pendingMaxProducts}{' '}
          products
        </dd>
        <dt className="text-text-2">Owner ID</dt>
        <dd className="font-mono break-all">{npubOf(view.owner)}</dd>
        <dt className="text-text-2">Store ID</dt>
        <dd className="font-mono break-all">{npubOf(view.storePubkey)}</dd>
      </dl>
      {view.status === 'pending' ? (
        <Notice tone="info">
          Your store is waiting for activation by PayCore. Finish the steps below meanwhile: it goes
          live as soon as it is activated.
        </Notice>
      ) : null}
      {view.alerts.map((kind) => (
        <Notice key={kind} tone="warn">
          {alertMessage(kind)}
        </Notice>
      ))}
      <Checklist api={session.api} view={view} />
      <PayoutListSection
        session={session}
        view={view}
        payouts={view.config?.draftPayouts ?? []}
        onChanged={onChanged}
      />
      <AuthorizationSection session={session} view={view} onChanged={onChanged} />
    </div>
  );
}
