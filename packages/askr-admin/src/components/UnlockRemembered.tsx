import { useEffect, useRef, useState } from 'react';
import { type RememberedKey, forgetKey, nextTask, unlockKey } from '../lib/remembered';
import { npubOf } from '../lib/signer';
import { Notice } from './Notice';
import { SelectField } from './SelectField';

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

/** Unlock a secret key this device remembers, with its password, or forget it. */
export function UnlockRemembered({ keys, onUnlocked, onForgotten }: Props) {
  const [chosen, setChosen] = useState(keys[0]?.store ?? '');
  const password = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const selected = keys.find((key) => key.store === chosen) ?? keys[0];

  // Leaving the page keeps it in the back/forward cache: a typed password must not come back.
  useEffect(() => {
    const clear = () => {
      if (password.current !== null) {
        password.current.value = '';
      }
    };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);

  if (selected === undefined) {
    return null;
  }

  const unlock = async () => {
    const field = password.current;
    if (field === null || busy) {
      return;
    }
    const typed = field.value;
    field.value = '';
    if (typed === '') {
      setError('Type the password you chose for this device.');
      return;
    }
    setBusy(true);
    setError('');
    await nextTask();
    const outcome = unlockKey(selected, typed);
    setBusy(false);
    if (outcome.ok) {
      onUnlocked(outcome.secretKey);
      return;
    }
    setError(
      outcome.reason === 'password'
        ? 'That password does not unlock the key remembered here. Try again, or sign in with your secret key below.'
        : 'The key remembered here does not match its Store ID. Forget it and sign in with your secret key.',
    );
  };

  const forget = () => {
    setConfirming(false);
    setError('');
    if (!forgetKey(selected.store)) {
      setError('This browser did not let the admin forget it. Try again.');
      return;
    }
    onForgotten();
  };

  return (
    <div className="card flex flex-col gap-12">
      <p className="text-14 font-medium">Unlock with your password</p>
      {keys.length > 1 ? (
        <SelectField
          id="remembered-store"
          label="Store"
          value={selected.store}
          options={keys.map((key) => ({ value: key.store, label: shortStoreId(key.store) }))}
          onChange={(store) => {
            setChosen(store);
            setError('');
            setConfirming(false);
          }}
        />
      ) : (
        <p className="text-13 text-text-2">
          This device remembers the secret key of store{' '}
          <span className="font-mono">{shortStoreId(selected.store)}</span>.
        </p>
      )}
      <label className="field" htmlFor="unlock-password">
        <span className="field-label">Password</span>
        <input
          id="unlock-password"
          ref={password}
          className="input"
          type="password"
          autoComplete="current-password"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void unlock();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => void unlock()}
      >
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            Forget the key remembered for store {shortStoreId(selected.store)}? After this you need
            your secret key, or the file you downloaded, to sign in on this device.
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
        <button type="button" className="text-14 underline" onClick={() => setConfirming(true)}>
          Forget this device
        </button>
      )}
    </div>
  );
}
