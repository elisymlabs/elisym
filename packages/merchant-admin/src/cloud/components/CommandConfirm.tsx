import { type ReactNode, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import {
  type CommandState,
  type OrderCommand,
  commandArgs,
  commandConsequence,
} from '../lib/orders';
import { useFollowedCycle } from '../lib/use-followed-cycle';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  command: OrderCommand;
  /** Closes the confirmation (cancelled, or the command finished and was read). */
  onClose: () => void;
  /** The command finished (done or failed): the orders are read again. */
  onFinished: () => void;
}

type Stage =
  | { step: 'asking' }
  | { step: 'sending' }
  | { step: 'following'; cycleId: number }
  | { step: 'refused'; reason: string };

const STATE_TEXT: Record<CommandState['stage'], string> = {
  waiting: 'Queued: the store runs it shortly (it stops for a moment to do so).',
  done: 'Done.',
  failed: 'The store could not finish it',
  replaced: 'It was replaced by a newer change to the store before it ran: nothing was sent.',
};

/**
 * One owner command, asked once more before it is queued: what it does, then
 * Confirm. Once queued its cycle is followed until it finishes; the page can
 * be left meanwhile (the command runs anyway).
 */
export function CommandConfirm({ api, tenantId, command, onClose, onFinished }: Props) {
  const [stage, setStage] = useState<Stage>({ step: 'asking' });
  const inFlight = useRef(false);
  const args = commandArgs(command);
  const followed = useFollowedCycle(
    api,
    tenantId,
    stage.step === 'following' ? stage.cycleId : undefined,
    onFinished,
  );

  const confirm = async () => {
    if (inFlight.current || args === undefined) {
      return;
    }
    inFlight.current = true;
    setStage({ step: 'sending' });
    const answer = await api.request('POST', `/tenants/${tenantId}/commands`, { args });
    const cycleId = fieldOf(answer.body, 'cycleId');
    if (answer.status === 200 && typeof cycleId === 'number') {
      setStage({ step: 'following', cycleId });
      return;
    }
    inFlight.current = false;
    setStage({ step: 'refused', reason: explainAnswer(answer.body, answer.status) });
  };

  let body: ReactNode;
  if (args === undefined) {
    body = (
      <p role="alert" className="text-13 text-error">
        {command.kind === 'refund'
          ? 'A value has characters the store cannot take: check the transaction and amount.'
          : 'This order key has characters the store cannot take.'}
      </p>
    );
  } else if (stage.step === 'asking' || stage.step === 'sending') {
    body = (
      <>
        <p className="text-14">{commandConsequence(command)}</p>
        <div className="flex gap-8">
          <Button
            disabled={stage.step === 'sending'}
            onClick={() => void confirm()}
            variant="primary"
          >
            Confirm
          </Button>
          <Button disabled={stage.step === 'sending'} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </>
    );
  } else if (followed?.stage === 'lost') {
    body = (
      <p role="alert" className="text-13 text-error">
        It was queued, but its progress cannot be read: read the orders again to see what happened.
      </p>
    );
  } else if (stage.step === 'refused') {
    body = (
      <p role="alert" className="text-13 text-error">
        {stage.reason}
      </p>
    );
  } else if (followed === undefined || followed.stage === 'waiting') {
    body = (
      <p role="status" className="text-13 text-text-2">
        {STATE_TEXT.waiting}
      </p>
    );
  } else if (followed.stage === 'done') {
    body = (
      <>
        <p role="status" className="text-13 text-text-2">
          {STATE_TEXT.done}
        </p>
        {followed.output === '' ? null : (
          <pre className="text-12 bg-surface rounded-10 overflow-x-auto p-8 break-all whitespace-pre-wrap">
            {followed.output}
          </pre>
        )}
      </>
    );
  } else if (followed.stage === 'failed') {
    body = (
      <p role="alert" className="text-13 text-error">
        {STATE_TEXT.failed}: {followed.reason}
      </p>
    );
  } else {
    body = (
      <p role="status" className="text-13 text-text-2">
        {STATE_TEXT[followed.stage]}
      </p>
    );
  }
  // Once queued it runs whether or not it is followed here.
  const closable = args === undefined || (stage.step !== 'asking' && stage.step !== 'sending');

  return (
    <div className="rounded-12 bg-surface-2 mt-8 flex flex-col gap-8 p-12">
      {body}
      {closable ? (
        <Button onClick={onClose} size="sm" className="self-start">
          Close
        </Button>
      ) : null}
    </div>
  );
}
