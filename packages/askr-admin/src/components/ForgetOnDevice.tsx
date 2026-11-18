import { useState } from 'react';
import { forgetKey, isRemembered } from '../lib/remembered';
import { Notice } from './Notice';

interface Props {
  /** The Store ID (hex) whose remembered key this forgets. */
  store: string;
}

/** Forget the secret key this device remembers for this store, after a confirmation. */
export function ForgetOnDevice({ store }: Props) {
  const [remembered, setRemembered] = useState(() => isRemembered(store));
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<'forgotten' | 'failed'>();

  const forget = () => {
    setConfirming(false);
    if (forgetKey(store)) {
      setRemembered(false);
      setOutcome('forgotten');
    } else {
      setOutcome('failed');
    }
  };

  if (outcome === 'forgotten') {
    return (
      <Notice tone="info">
        This device no longer remembers this secret key. Next time, sign in with your secret key.
      </Notice>
    );
  }
  if (!remembered) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      <p className="text-14 text-text-2">
        This device remembers this secret key, so you sign in here without typing it.
      </p>
      {outcome === 'failed' ? (
        <Notice tone="error">This browser did not let the admin forget it. Try again.</Notice>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            After this you need your secret key, or the file you downloaded, to sign in on this
            device.
          </Notice>
          <div className="flex gap-8">
            <button type="button" className="btn btn-primary" onClick={forget}>
              Forget
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Forget this device
          </button>
        </div>
      )}
    </div>
  );
}
