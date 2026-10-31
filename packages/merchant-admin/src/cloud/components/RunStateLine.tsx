import { Button } from '../../components/Button';
import { ToneBadge } from '../../components/ToneBadge';
import type { RunState } from '../lib/status';

interface Props {
  runState: RunState;
  /** The poll ran out: offered to read the state again. */
  onCheckAgain: (() => void) | undefined;
}

const SHOWN: Record<RunState, { tone: 'ok' | 'wait' | 'warn' | 'off'; text: string }> = {
  live: { tone: 'ok', text: 'Live' },
  starting: { tone: 'wait', text: 'Starting' },
  applying: { tone: 'wait', text: 'Applying a change' },
  needs_resign: { tone: 'warn', text: 'Needs you: sign your payouts again' },
  could_not_start: { tone: 'warn', text: 'Could not start: we have been alerted' },
  off_sale: { tone: 'off', text: 'Off sale' },
  paused_by_owner: { tone: 'off', text: 'Paused by you' },
  paused_payment_due: { tone: 'warn', text: 'Paused: payment due' },
  held: { tone: 'warn', text: 'Paused by us: contact us' },
  not_launched: { tone: 'off', text: 'Not launched' },
  gone: { tone: 'off', text: 'Handed over' },
};

/** The store's state in words, as its status reads it. */
export function RunStateLine({ runState, onCheckAgain }: Props) {
  const shown = SHOWN[runState];
  return (
    <div className="flex flex-wrap items-center gap-12">
      <p className="text-14 flex items-center gap-8" data-run-state={runState}>
        Your store: <ToneBadge tone={shown.tone}>{shown.text}</ToneBadge>
      </p>
      {onCheckAgain === undefined ? null : (
        <Button size="sm" onClick={onCheckAgain}>
          Check again
        </Button>
      )}
    </div>
  );
}
