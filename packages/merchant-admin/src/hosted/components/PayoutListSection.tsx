import type { ReactNode } from 'react';
import { KIND_PAYOUT_LIST } from '../lib/owner-event-check';
import type { StoreSession } from '../lib/store-session';
import type { Payout, StoreView } from '../lib/types';
import { OwnerEventAction } from './OwnerEventAction';
import { OwnerEventStatus } from './OwnerEventStatus';

interface Props {
  session: StoreSession;
  view: StoreView;
  /** The payout rows the list must name: what this page saved, else the view's draft. */
  payouts: readonly Payout[];
  onChanged: () => void;
}

/** The payout list (10133): where it stands, and "Publish payout list" while the saved payouts are not signed. */
export function PayoutListSection({ session, view, payouts, onChanged }: Props) {
  const committed = view.ownerEvents.payto;
  const { needsSigning } = view.payouts;
  const pendingStore = view.status === 'pending';
  let status: ReactNode = null;
  if (committed !== null && !needsSigning) {
    status = (
      <OwnerEventStatus
        id="payto"
        committed={committed}
        pendingStore={pendingStore}
        session={session}
        onChanged={onChanged}
      />
    );
  } else if (committed !== null) {
    status = (
      <p className="text-14" id="payto-status">
        Your payouts changed since your payout list was signed: publish it again.
      </p>
    );
  } else if (payouts.length === 0) {
    status = (
      <p className="text-14" id="payto-status">
        Save your payouts first.
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-8">
      <h2 className="text-16 font-semibold">Payout list</h2>
      <p className="text-13 text-text-2">
        Your owner key signs the list of addresses buyers pay to. Only you can change it.
      </p>
      {status}
      <OwnerEventAction
        kind={KIND_PAYOUT_LIST}
        label="Publish payout list"
        session={session}
        storePubkey={view.storePubkey}
        pendingStore={pendingStore}
        payouts={payouts}
        needed={needsSigning && payouts.length > 0}
        onCommitted={onChanged}
      />
    </section>
  );
}
