import { classifyJobError } from '@elisym/sdk';
import { heldPaymentNote } from '../../lib/heldPaymentNote';

interface Props {
  error: string;
  paid: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid }: Props) {
  const isAgentUnavailable = classifyJobError(error) === 'agent-unavailable';
  const held = heldPaymentNote(error, paid);
  return (
    <div className="px-20 pb-12 text-xs text-red-500">
      <div>{isAgentUnavailable ? 'Agent unavailable. Try again later.' : error}</div>
      {held && <div className="mt-4 text-text-2">{held}</div>}
    </div>
  );
}
