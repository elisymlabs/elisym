import { classifyJobError } from '@elisym/sdk';
import { boundedErrorText, customerErrorText } from '../../lib/errorText';
import { clientFailureNote, heldPaymentNote } from '../../lib/heldPaymentNote';

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
   * Whether the agent's refusal is already on screen in the thread's failed
   * bubble; then this note has nothing left to add and renders nothing.
   *
   * Required, with no default: a surface that forgets it would print the
   * refusal and the money paragraph twice, and "false" has to be something a
   * call site decided rather than something it omitted. Never inferred from the
   * tab either - the bubble is a separate write that can fail, and a refusal
   * nobody explains is the worst outcome here.
   */
  refusalInThread: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid, fromJob, refusalInThread }: Props) {
  // Bounded and flattened whoever wrote it - most of these are the app's own
  // words, but a job error can be a stranger's, and neither surface may paint
  // control characters or thousands of unbroken characters into the page.
  if (!fromJob) {
    // Not classified at all: this text is the app's own, so no provider verdict
    // applies to it - and `heldPaymentNote` would have nothing true to say,
    // since every sentence it knows is one the RUNTIME writes. The money
    // question still gets an answer, because `paid` can be true here the moment
    // a step fails on this side after the payment landed.
    return <Note body={boundedErrorText(error)} held={clientFailureNote(paid)} />;
  }
  // Classified ONCE, for both decisions below.
  const kind = classifyJobError(error);
  if (refusalInThread && kind === 'provider-refused') {
    // The bubble carries BOTH halves - the agent's sentence and where the money
    // went - so this note has nothing left to add. Suppressing only the
    // sentence would print the money paragraph twice.
    return null;
  }
  return <Note body={customerErrorText(error, kind)} held={heldPaymentNote(error, paid, kind)} />;
}

function Note({ body, held }: { body: string; held?: string }) {
  return (
    <div className="px-20 pb-12 text-xs break-words text-red-500">
      <div>{body}</div>
      {held !== undefined && <div className="mt-4 text-text-2">{held}</div>}
    </div>
  );
}
