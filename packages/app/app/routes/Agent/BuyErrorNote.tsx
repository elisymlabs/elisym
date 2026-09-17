import { customerErrorText } from '../../lib/errorText';
import { heldPaymentNote } from '../../lib/heldPaymentNote';

interface Props {
  error: string;
  paid: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid }: Props) {
  const held = heldPaymentNote(error, paid);
  // A refusal is the provider's own words: flattened and bounded here exactly
  // as when the thread stores it, so the sentence on screen now and the one
  // after a reload are the same. Every other error is bounded too - most are
  // the app's own, but a job error can be a stranger's, and neither surface
  // can paint control characters or thousands of unbroken characters into the
  // page.
  const body = customerErrorText(error);
  return (
    <div className="px-20 pb-12 text-xs break-words text-red-500">
      <div>{body}</div>
      {held && <div className="mt-4 text-text-2">{held}</div>}
    </div>
  );
}
