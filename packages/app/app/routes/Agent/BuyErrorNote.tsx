import { classifyJobError } from '@elisym/sdk';
import { boundedErrorText, customerErrorText } from '../../lib/errorText';
import { heldPaymentNote } from '../../lib/heldPaymentNote';

interface Props {
  error: string;
  paid: boolean;
  /**
   * Where the message came from. A JOB error is the provider's verdict and is
   * classified as one; an APP error is a wallet rejection or an RPC failure,
   * and reading its "insufficient SOL" as an agent outage would tell the
   * customer to wait for a retry that is not coming.
   */
  fromJob: boolean;
  /**
   * Set when the agent's refusal is already on screen in the thread's failed
   * bubble - the note then carries only what the bubble does not, which is
   * where the money went. Never assumed from the tab: the bubble is a separate
   * write that can fail, and a refusal nobody explains is the worst outcome
   * here.
   */
  refusalInThread?: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid, fromJob, refusalInThread = false }: Props) {
  // Bounded and flattened whoever wrote it - most of these are the app's own
  // words, but a job error can be a stranger's, and neither surface may paint
  // control characters or thousands of unbroken characters into the page.
  if (!fromJob) {
    // `'unknown'`, not a classification: this text is the app's own, so none of
    // the provider verdicts can apply to it - but the money question is still
    // asked rather than dropped, since `paid` can be true here the moment a
    // post-payment step fails on this side.
    return <Note body={boundedErrorText(error)} held={heldPaymentNote(error, paid, 'unknown')} />;
  }
  // Classified ONCE, for both decisions below.
  const kind = classifyJobError(error);
  const held = heldPaymentNote(error, paid, kind);
  const restated = refusalInThread && kind === 'provider-refused';
  return <Note body={restated ? undefined : customerErrorText(error, kind)} held={held} />;
}

function Note({ body, held }: { body?: string; held?: string }) {
  if (body === undefined && held === undefined) {
    return null;
  }
  return (
    <div className="px-20 pb-12 text-xs break-words text-red-500">
      {body !== undefined && <div>{body}</div>}
      {held !== undefined && (
        <div className={body === undefined ? 'text-text-2' : 'mt-4 text-text-2'}>{held}</div>
      )}
    </div>
  );
}
