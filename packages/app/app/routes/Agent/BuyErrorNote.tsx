import { classifyJobError } from '@elisym/sdk';
import { heldPaymentNote } from '../../lib/heldPaymentNote';
import { storedRefusal } from '../../lib/refusal';

interface Props {
  error: string;
  paid: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid }: Props) {
  const kind = classifyJobError(error);
  const held = heldPaymentNote(error, paid);
  // A refusal is the provider's own words: flattened and bounded here exactly
  // as when the thread stores it, so the sentence on screen now and the one
  // after a reload are the same, and neither can paint control characters or
  // thousands of unbroken characters into the page.
  let body = error;
  if (kind === 'agent-unavailable') {
    body = 'Agent unavailable. Try again later.';
  } else if (kind === 'provider-refused') {
    body = `The agent refused: ${storedRefusal(error)}`;
  }
  return (
    <div className="px-20 pb-12 text-xs break-words text-red-500">
      <div>{body}</div>
      {held && <div className="mt-4 text-text-2">{held}</div>}
    </div>
  );
}
