import { classifyJobError } from '@elisym/sdk';
import { customerErrorText } from '../../lib/errorText';
import { heldPaymentNote } from '../../lib/heldPaymentNote';

interface Props {
  error: string;
  paid: boolean;
  /**
   * The Chat tab renders the agent's refusal in the failed bubble already. The
   * note then carries only what the bubble does not: where the money went. The
   * Products tab has no bubble, so it leaves this off and says both.
   */
  refusalInThread?: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid, refusalInThread = false }: Props) {
  const held = heldPaymentNote(error, paid);
  // A refusal is the provider's own words: flattened and bounded here exactly
  // as when the thread stores it, so the sentence on screen now and the one
  // after a reload are the same. Every other error is bounded too - most are
  // the app's own, but a job error can be a stranger's, and neither surface
  // can paint control characters or thousands of unbroken characters into the
  // page.
  const restated = refusalInThread && classifyJobError(error) === 'provider-refused';
  const body = restated ? undefined : customerErrorText(error);
  if (body === undefined && held === undefined) {
    return null;
  }
  return (
    <div className="px-20 pb-12 text-xs break-words text-red-500">
      {body !== undefined && <div>{body}</div>}
      {held && (
        <div className={body === undefined ? 'text-text-2' : 'mt-4 text-text-2'}>{held}</div>
      )}
    </div>
  );
}
