/** Shown when the signed-in key already signed a payout list or a store authorization. */
export function KeyInUseWarning() {
  return (
    <p role="alert" className="rounded-12 bg-warn-bg text-14 text-warn w-full p-16 leading-relaxed">
      This key already signed a payout list or a store authorization on the relays: it may run
      another store. One key per store: sign out and create a new key for this one.
    </p>
  );
}
