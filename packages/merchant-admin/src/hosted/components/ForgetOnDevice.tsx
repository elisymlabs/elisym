import { useState } from 'react';
import { forgetKey, isRemembered } from '../lib/remembered';
import { BUTTON_SECONDARY } from '../styles';
import { Notice } from './Notice';

interface Props {
  /** The owner (hex) whose remembered key this forgets. */
  owner: string;
}

/** Forget the owner key this device remembers, after a confirmation. */
export function ForgetOnDevice({ owner }: Props) {
  const [remembered, setRemembered] = useState(() => isRemembered(owner));
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<'forgotten' | 'failed'>();

  const forget = () => {
    setConfirming(false);
    if (forgetKey(owner)) {
      setRemembered(false);
      setOutcome('forgotten');
    } else {
      setOutcome('failed');
    }
  };

  if (outcome === 'forgotten') {
    return (
      <Notice tone="info">
        This device no longer remembers your owner key. Next time, sign in with your owner key.
      </Notice>
    );
  }
  if (!remembered) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      <p className="text-14 text-text-2">
        This device remembers your owner key, so you sign in here without typing it.
      </p>
      {outcome === 'failed' ? (
        <Notice tone="error">This browser did not let the admin forget it. Try again.</Notice>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            After this you need your owner key, or the file you downloaded, to sign in on this
            device.
          </Notice>
          <div className="flex gap-8">
            <button type="button" className={BUTTON_SECONDARY} onClick={forget}>
              Forget
            </button>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirming(true)}>
            Forget this device
          </button>
        </div>
      )}
    </div>
  );
}
