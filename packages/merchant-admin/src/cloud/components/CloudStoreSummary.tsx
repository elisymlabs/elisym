import type { StoreStatus } from '../lib/status';
import { type StoreView, shownTime } from '../lib/store-view';
import { Card } from './Card';
import { RunStateLine } from './RunStateLine';

interface Props {
  tenantId: string;
  view: StoreView;
  /** The store's status, once read and not gone (its run state and this month's paid orders). */
  status: StoreStatus | undefined;
  /** The status poll ran out: offered to read it again. */
  onCheckAgain: (() => void) | undefined;
}

/** The store at a glance: its run state, plan, network, paid time and this month's orders. */
export function CloudStoreSummary({ tenantId, view, status, onCheckAgain }: Props) {
  return (
    <Card title="Your store">
      {status === undefined ? null : (
        <div className="mt-12 flex w-full flex-col gap-4">
          <RunStateLine runState={status.runState} onCheckAgain={onCheckAgain} />
          <p className="text-13 text-text-2">
            Paid orders this month: {status.usage.paidOrders.toLocaleString('en-US')}
            {status.usage.ordersPerMonth === undefined
              ? ''
              : ` of ${status.usage.ordersPerMonth.toLocaleString('en-US')} on your plan`}
            .
          </p>
        </div>
      )}
      <dl className="text-14 mt-12 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4">
        <dt className="text-text-3">Store</dt>
        <dd className="font-mono">{tenantId}</dd>
        <dt className="text-text-3">Plan</dt>
        <dd>{view.tierName}</dd>
        <dt className="text-text-3">Network</dt>
        <dd>{view.network}</dd>
        <dt className="text-text-3">Status</dt>
        <dd>{view.activated ? 'Activated' : 'Not activated yet'}</dd>
        <dt className="text-text-3">Paid until</dt>
        <dd>{view.paidUntil === undefined ? 'Not paid yet' : shownTime(view.paidUntil)}</dd>
        {view.partner === undefined ? null : (
          <>
            <dt className="text-text-3">Partner pays until</dt>
            <dd>
              {view.partner.paidUntil === undefined
                ? 'Not paid yet'
                : shownTime(view.partner.paidUntil)}
            </dd>
          </>
        )}
        {view.payBy === undefined ? null : (
          <>
            <dt className="text-text-3">Pay by</dt>
            <dd className="text-error">{shownTime(view.payBy)}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}
