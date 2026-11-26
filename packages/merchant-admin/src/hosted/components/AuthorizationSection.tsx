import { KIND_AUTHORIZATION } from '../lib/owner-event-check';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { OwnerEventAction } from './OwnerEventAction';
import { OwnerEventStatus } from './OwnerEventStatus';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

/** The authorization (30490) that lets PayCore run the store with its store key. */
export function AuthorizationSection({ session, view, onChanged }: Props) {
  const committed = view.ownerEvents.auth;
  const pendingStore = view.status === 'pending';
  return (
    <section className="flex flex-col gap-8">
      <h2 className="text-16 font-semibold">Authorization</h2>
      <p className="text-13 text-text-2">
        Your owner key authorizes PayCore to run your store: publish your products and take orders.
        It never lets PayCore move your money or change your payout addresses.
      </p>
      {committed === null ? null : (
        <OwnerEventStatus
          id="auth"
          committed={committed}
          pendingStore={pendingStore}
          session={session}
          onChanged={onChanged}
        />
      )}
      <OwnerEventAction
        kind={KIND_AUTHORIZATION}
        label="Authorize PayCore"
        session={session}
        storePubkey={view.storePubkey}
        pendingStore={pendingStore}
        payouts={[]}
        needed={committed === null}
        onCommitted={onChanged}
      />
    </section>
  );
}
