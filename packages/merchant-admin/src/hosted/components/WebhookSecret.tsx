import { useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { errorMessage } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

export const SECRET_MISSING =
  'Your webhook has no secret, so nothing is sent to it: your store needs attention until you generate one. Generate a secret and set it on your server.';
export const NO_WEBHOOK =
  'No webhook URL is saved. Save one above to have your server told of each paid order, then generate its secret here.';
export const ROTATE_AT_ONCE =
  'A new secret replaces the old one at once: update your server right away. Webhooks sent in between fail its check and are retried until their deadline (7 days after the payment).';
export const SECRET_ONCE =
  'This is the only time this secret is shown: copy it to your server now. This page does not keep it.';

type Stage =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'shown'; secret: string };

/**
 * The webhook secret (A12): generated or rotated by the server, shown once
 * here and kept nowhere in the browser. A URL saved without a secret is
 * prompted to generate one.
 */
export function WebhookSecret({ session, view, onChanged }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const hasUrl = view.config?.webhookUrl !== undefined;
  const isSet = view.webhookSecretSet;

  const rotate = async () => {
    setStage({ kind: 'busy' });
    setProblem(undefined);
    try {
      const { secret } = await session.api.rotateWebhookSecret();
      setStage({ kind: 'shown', secret });
      onChanged();
    } catch (error) {
      setProblem(errorMessage(error));
      setStage({ kind: 'idle' });
    }
  };

  let body;
  if (stage.kind === 'shown') {
    body = (
      <div className="flex flex-col gap-8">
        <Notice tone="warn">{SECRET_ONCE}</Notice>
        <div className="flex items-center gap-8">
          <code id="webhook-secret" className="text-13 font-mono break-all">
            {stage.secret}
          </code>
          <CopyButton text={stage.secret} label="Copy the webhook secret" />
        </div>
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => setStage({ kind: 'idle' })}
          >
            I copied it
          </button>
        </div>
      </div>
    );
  } else if (stage.kind === 'confirm') {
    body = (
      <div className="flex flex-col gap-8">
        <Notice tone="warn">{ROTATE_AT_ONCE}</Notice>
        <div className="flex gap-8">
          <button type="button" className={BUTTON_SECONDARY} onClick={() => void rotate()}>
            Rotate now
          </button>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => setStage({ kind: 'idle' })}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (isSet) {
    body = (
      <div className="flex flex-col gap-8">
        <p className="text-14 text-text-2">A secret is set. {ROTATE_AT_ONCE}</p>
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={stage.kind === 'busy'}
            onClick={() => setStage({ kind: 'confirm' })}
          >
            Rotate secret
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        {hasUrl ? (
          <Notice tone="warn">{SECRET_MISSING}</Notice>
        ) : (
          <p className="text-14 text-text-2">{NO_WEBHOOK}</p>
        )}
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={stage.kind === 'busy'}
            onClick={() => void rotate()}
          >
            Generate a secret
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-8" aria-labelledby="webhook-secret-heading">
      <h2 id="webhook-secret-heading" className="text-16 font-semibold">
        Webhook secret
      </h2>
      {body}
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </section>
  );
}
