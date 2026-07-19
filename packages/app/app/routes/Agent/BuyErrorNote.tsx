import { classifyJobError } from '@elisym/sdk';

interface Props {
  error: string;
  paid: boolean;
}

/** Inline buy-flow error, shared by the Products-tab JobInput and the Chat composer. */
export function BuyErrorNote({ error, paid }: Props) {
  const isAgentUnavailable = classifyJobError(error) === 'agent-unavailable';
  if (isAgentUnavailable) {
    return (
      <div className="px-20 pb-12 text-xs text-red-500">
        <div>Agent unavailable. Try again later.</div>
        {paid && (
          <div className="mt-4 text-text-2">
            Your payment is held. Once the agent is back online, the job will be retried
            automatically and the result delivered.
          </div>
        )}
      </div>
    );
  }
  return <div className="px-20 pb-12 text-xs text-red-500">{error}</div>;
}
