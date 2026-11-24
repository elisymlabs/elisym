import { useEffect, useRef, useState } from 'react';
import { type RememberedKey, forgetKey, readRemembered, unlockKey } from '../lib/remembered';
import { npubOf } from '../lib/signer';
import { tabSignedInOwner } from '../lib/tab-session';
import { BUTTON_SECONDARY, CARD } from '../styles';
import { Notice } from './Notice';

interface Props {
  keys: readonly RememberedKey[];
  /** The caller makes its own copy: this one is zeroed right after. */
  onUnlocked: (secretKey: Uint8Array) => void;
  /** Something was forgotten: read the remembered keys again. */
  onForgotten: () => void;
}

const SHORT_OWNER_ID_HEAD = 12;
const SHORT_OWNER_ID_TAIL = 6;

function shortOwnerId(owner: string): string {
  const npub = npubOf(owner);
  return `${npub.slice(0, SHORT_OWNER_ID_HEAD)}...${npub.slice(-SHORT_OWNER_ID_TAIL)}`;
}

const UNLOCK_ERRORS = {
  lost: 'This browser can no longer open the key it remembered (part of its site data was cleared). Forget it and sign in with your owner key.',
  mismatch:
    'The key remembered here does not match its Owner ID. Forget it and sign in with your owner key.',
  unavailable: "This browser's storage did not answer. Try again in a moment.",
} as const;

const FORGOTTEN_MEANWHILE =
  'This key is no longer remembered here (it was forgotten in another tab). Sign in with your owner key.';

const PRIMARY_SMALL =
  'rounded-10 bg-ink text-14 text-ink-text px-14 py-8 font-semibold transition hover:opacity-90 disabled:opacity-45';

/** Sign in with an owner key this device remembers, in one press, or forget it. */
export function UnlockRemembered({ keys, onUnlocked, onForgotten }: Props) {
  const [busy, setBusy] = useState('');
  /** Set at once on a press, before React re-renders: a double press signs in once. */
  const working = useRef(false);
  const [error, setError] = useState<{ owner: string; message: string }>();
  const [confirming, setConfirming] = useState('');
  /** A reload of a tab that was signed in: that owner signs in again once, with no press. */
  const resumed = useRef(false);

  const unlock = async (key: RememberedKey) => {
    if (working.current) {
      return;
    }
    // Forgotten in another tab since this page read the list: it is not used.
    const current = readRemembered().keys.find((known) => known.owner === key.owner);
    if (current === undefined) {
      setError({ owner: key.owner, message: FORGOTTEN_MEANWHILE });
      return;
    }
    working.current = true;
    setBusy(key.owner);
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
    setError({ owner: key.owner, message: UNLOCK_ERRORS[outcome.reason] });
  };

  useEffect(() => {
    if (resumed.current) {
      return;
    }
    resumed.current = true;
    const owner = tabSignedInOwner();
    const key = keys.find((known) => known.owner === owner);
    if (key !== undefined) {
      void unlock(key);
    }
    // Once, on the first render: a later change of the list is a forget, not a reload.
  }, []);

  const forget = (owner: string) => {
    setConfirming('');
    setError(undefined);
    if (!forgetKey(owner)) {
      setError({ owner, message: 'This browser did not let the admin forget it. Try again.' });
      return;
    }
    onForgotten();
  };

  return (
    <div className={`${CARD} flex flex-col gap-12`}>
      <p className="text-15 font-semibold">Continue on this device</p>
      <ul className="border-line rounded-10 divide-line flex flex-col divide-y border">
        {keys.map((key) => (
          <li key={key.owner} className="flex flex-col gap-10 px-14 py-12">
            <div className="flex flex-wrap items-center justify-between gap-12">
              <div className="flex min-w-0 flex-col">
                <span className="text-13 text-text-2">Owner</span>
                <span className="text-13 truncate font-mono">{shortOwnerId(key.owner)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-8">
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  disabled={busy !== ''}
                  aria-label={`Forget owner ${shortOwnerId(key.owner)} on this device`}
                  onClick={() => setConfirming(key.owner)}
                >
                  Forget
                </button>
                <button
                  type="button"
                  className={PRIMARY_SMALL}
                  disabled={busy !== ''}
                  aria-label={`Continue as owner ${shortOwnerId(key.owner)}`}
                  onClick={() => void unlock(key)}
                >
                  {busy === key.owner ? 'Signing in...' : 'Continue'}
                </button>
              </div>
            </div>
            {error?.owner === key.owner ? <Notice tone="error">{error.message}</Notice> : null}
            {confirming === key.owner ? (
              <div className="flex flex-col gap-8">
                <Notice tone="warn">
                  Forget the key remembered for owner {shortOwnerId(key.owner)}? After this you need
                  your owner key, or the file you downloaded, to sign in on this device.
                </Notice>
                <div className="flex gap-8">
                  <button
                    type="button"
                    className={PRIMARY_SMALL}
                    disabled={busy !== ''}
                    onClick={() => forget(key.owner)}
                  >
                    Forget
                  </button>
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    onClick={() => setConfirming('')}
                  >
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
