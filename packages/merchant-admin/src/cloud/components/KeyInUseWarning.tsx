/** Shown when the signed-in key already signed a payout list or a store authorization. */
export function KeyInUseWarning() {
  return (
    <p role="alert" className="rounded-12 bg-warn-bg text-14 text-warn w-full p-16 leading-relaxed">
      This key already signed payouts or a sign-in for a store: it may run another store. One key
      per store: sign out and create a new access key for this one.
    </p>
  );
}
