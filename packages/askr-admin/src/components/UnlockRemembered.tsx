import { useRef, useState } from 'react';
import { type RememberedKey, forgetKey, readRemembered, unlockKey } from '../lib/remembered';
import { npubOf } from '../lib/signer';
import { Notice } from './Notice';

interface Props {
  keys: readonly RememberedKey[];
  onUnlocked: (secretKey: Uint8Array) => void;
  /** Something was forgotten: read the remembered keys again. */
  onForgotten: () => void;
}

const SHORT_STORE_ID_HEAD = 12;
const SHORT_STORE_ID_TAIL = 6;

function shortStoreId(store: string): string {
  const npub = npubOf(store);
  return `${npub.slice(0, SHORT_STORE_ID_HEAD)}...${npub.slice(-SHORT_STORE_ID_TAIL)}`;
}

const UNLOCK_ERRORS = {
  lost: 'This browser can no longer open the key it remembered (part of its site data was cleared). Forget it and sign in with your secret key.',
  mismatch:
    'The key remembered here does not match its Store ID. Forget it and sign in with your secret key.',
  unavailable: "This browser's storage did not answer. Try again in a moment.",
} as const;

const FORGOTTEN_MEANWHILE =
  'This key is no longer remembered here (it was forgotten in another tab). Sign in with your secret key.';

/** Sign in with a secret key this device remembers, in one press, or forget it. */
export function UnlockRemembered({ keys, onUnlocked, onForgotten }: Props) {
  const [busy, setBusy] = useState('');
  /** Set at once on a press, before React re-renders: a double press signs in once. */
  const working = useRef(false);
  const [error, setError] = useState<{ store: string; message: string }>();
  const [confirming, setConfirming] = useState('');

  const unlock = async (key: RememberedKey) => {
    if (working.current) {
      return;
    }
    // Forgotten in another tab since this page read the list: it is not used.
    const current = readRemembered().keys.find((known) => known.store === key.store);
    if (current === undefined) {
      setError({ store: key.store, message: FORGOTTEN_MEANWHILE });
      return;
    }
    working.current = true;
    setBusy(key.store);
    setError(undefined);
    setConfirming('');
    const outcome = await unlockKey(current);
    setBusy('');
    working.current = false;
    if (outcome.ok) {
      try {
        onUnlocked(outcome.secretKey);
      } finally {
        // The signer keeps its own copy: this one is not left behind in memory.
        outcome.secretKey.fill(0);
      }
      return;
    }
    setError({ store: key.store, message: UNLOCK_ERRORS[outcome.reason] });
  };

  const forget = (store: string) => {
    setConfirming('');
    setError(undefined);
    if (!forgetKey(store)) {
      setError({ store, message: 'This browser did not let the admin forget it. Try again.' });
      return;
    }
    onForgotten();
  };

  return (
    <div className="card flex flex-col gap-12">
      <p className="text-14 font-medium">Continue on this device</p>
      <ul className="border-line rounded-10 rows flex flex-col border">
        {keys.map((key) => (
          <li key={key.store} className="flex flex-col gap-10 px-14 py-12">
            <div className="flex items-center justify-between gap-12">
              <div className="flex min-w-0 flex-col">
                <span className="text-13 text-text-2">Store</span>
                <span className="text-13 truncate font-mono">{shortStoreId(key.store)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== ''}
                  aria-label={`Forget store ${shortStoreId(key.store)} on this device`}
                  onClick={() => setConfirming(key.store)}
                >
                  Forget
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== ''}
                  aria-label={`Continue as store ${shortStoreId(key.store)}`}
                  onClick={() => void unlock(key)}
                >
                  {busy === key.store ? 'Signing in...' : 'Continue'}
                </button>
              </div>
            </div>
            {error?.store === key.store ? <Notice tone="error">{error.message}</Notice> : null}
            {confirming === key.store ? (
              <div className="flex flex-col gap-8">
                <Notice tone="warn">
                  Forget the key remembered for store {shortStoreId(key.store)}? After this you need
                  your secret key, or the file you downloaded, to sign in on this device.
                </Notice>
                <div className="flex gap-8">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== ''}
                    onClick={() => forget(key.store)}
                  >
                    Forget
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirming('')}>
                    Keep it
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
