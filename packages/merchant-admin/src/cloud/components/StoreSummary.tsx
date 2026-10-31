import { type StoreView, shownTime } from '../lib/store-view';

interface Props {
  tenantId: string;
  view: StoreView;
}

/** The store's plan, network, status and paid time. */
export function StoreSummary({ tenantId, view }: Props) {
  return (
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
  );
}
