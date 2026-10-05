import type { View } from '../session';

interface Props {
  view: Extract<View, { kind: 'waiting_store' }>;
}

/** Paid: the money is with the store, which completes the order. Nothing to do but wait, or contact it. */
export function WaitingStore({ view }: Props) {
  return (
    <>
      {view.cancelled ? (
        <p class="problem" role="alert">
          Paid, but the store cancelled this order. Contact the store.
        </p>
      ) : (
        <p class="status" role="status">
          Paid. Waiting for the store to confirm…
        </p>
      )}
      {view.noAnswer ? (
        <p class="note">The store has not answered for a while. Contact the store.</p>
      ) : null}
      {view.noAnswer || view.cancelled ? null : (
        <p class="note">Stores usually answer within minutes.</p>
      )}
      {view.explorer === undefined ? null : (
        <p>
          <a href={view.explorer} target="_blank" rel="noopener noreferrer">
            View the payment
          </a>
        </p>
      )}
    </>
  );
}
