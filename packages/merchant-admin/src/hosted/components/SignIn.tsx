import { useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { forgetDamaged, readRemembered, rememberKey } from '../lib/remembered';
import {
  type OwnerKey,
  type Signer,
  generateOwnerKey,
  parseSecretKey,
  secretKeySigner,
} from '../lib/signer';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, KEY_INPUT, LINK } from '../styles';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { type RememberChoice, type RememberHandle, RememberOption } from './RememberOption';
import { UnlockRemembered } from './UnlockRemembered';

interface Props {
  onSigner: (signer: Signer) => void;
}

const NOT_REMEMBERED =
  'Your owner key could not be remembered on this device. To go on without it, clear the remember box and try again.';

/**
 * Sign in with the owner key: paste it, unlock one this device remembers, or
 * make a new one. The key stays in this tab (and sealed on this device when
 * chosen): it is never sent anywhere.
 */
export function SignIn({ onSigner }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const remember = useRef<RememberHandle>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Set at once on a press, before React re-renders: a double press remembers and signs in once. */
  const working = useRef(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [remembered, setRemembered] = useState(readRemembered);
  const [generated, setGenerated] = useState<OwnerKey | undefined>(undefined);

  // Leaving the page keeps it in the back/forward cache: a typed key must not come back.
  useEffect(() => {
    const clear = () => {
      if (input.current !== null) {
        input.current.value = '';
      }
    };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);

  /**
   * Sign in as `secretKey`, after remembering it on this device when chosen.
   * True once signed in; `beforeSignIn` runs only then (it clears the key field).
   */
  const signInAs = async (
    secretKey: Uint8Array,
    choice: RememberChoice,
    beforeSignIn: () => void,
  ): Promise<boolean> => {
    working.current = true;
    try {
      if (choice.kind === 'on') {
        setBusy(true);
        setError('');
        if (!(await rememberKey(secretKey))) {
          setError(
            remembered.damaged
              ? `${NOT_REMEMBERED} Or clear what could not be read first.`
              : NOT_REMEMBERED,
          );
          return false;
        }
      }
      setError('');
      beforeSignIn();
      onSigner(secretKeySigner(secretKey));
      return true;
    } catch {
      setError('That owner key could not be used. Check it and try again.');
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const rememberChoice = (): RememberChoice => remember.current?.read() ?? { kind: 'off' };

  const pasteKey = async () => {
    const field = input.current;
    if (field === null || working.current) {
      return;
    }
    const secretKey = parseSecretKey(field.value);
    if (secretKey === undefined) {
      field.value = '';
      setError('That is not an owner key: paste an nsec or 64 hex characters.');
      return;
    }
    // A storage problem keeps the pasted key in the field, so a retry needs no second paste
    // (the field is still cleared when the page is hidden). The bytes here are not kept.
    try {
      await signInAs(secretKey, rememberChoice(), () => {
        field.value = '';
      });
    } finally {
      secretKey.fill(0);
    }
  };

  const continueWithNew = async (key: OwnerKey) => {
    if (!working.current && (await signInAs(key.secretKey, rememberChoice(), () => undefined))) {
      key.secretKey.fill(0);
    }
  };

  if (generated !== undefined) {
    return (
      <NewOwnerKey
        nsec={generated.nsec}
        npub={generated.npub}
        busy={busy}
        onContinue={() => void continueWithNew(generated)}
        onCancel={() => {
          generated.secretKey.fill(0);
          setGenerated(undefined);
          setError('');
        }}
      >
        <RememberOption ref={remember} id="new-key" label="Keep me signed in on this device" />
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
      </NewOwnerKey>
    );
  }

  const hasRemembered = remembered.keys.length > 0;
  return (
    <AuthLayout>
      <div className="flex w-full max-w-560 flex-col gap-20">
        <div className="flex flex-col gap-8">
          <h1 className="text-24 font-semibold tracking-tight">Sign in to your hosted store</h1>
          <p className="text-15 text-text-2 leading-relaxed">
            PayCore runs your store for you. Sign in with your owner key: it is never sent anywhere.
            It stays in this browser tab, and on this device unless you clear the remember box.
          </p>
        </div>
        {hasRemembered ? (
          <UnlockRemembered
            keys={remembered.keys}
            onUnlocked={(secretKey) => onSigner(secretKeySigner(secretKey))}
            onForgotten={() => setRemembered(readRemembered())}
          />
        ) : null}
        {remembered.newer === true ? (
          <Notice tone="warn">
            A newer version of this admin remembered a key on this device. Reload the page to unlock
            it; until then, sign in with your owner key.
          </Notice>
        ) : null}
        {remembered.damaged && !confirmingClear ? (
          <Notice tone="warn">
            A key remembered on this device could not be read, so it is not offered. Sign in with
            your owner key.{' '}
            <button type="button" className="underline" onClick={() => setConfirmingClear(true)}>
              Clear it
            </button>
          </Notice>
        ) : null}
        {remembered.damaged && confirmingClear ? (
          <div className="flex flex-col gap-8">
            <Notice tone="warn">
              Clear what could not be read? Keys this device remembers that can be read stay.
            </Notice>
            <div className="flex gap-8">
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => {
                  forgetDamaged();
                  setConfirmingClear(false);
                  setRemembered(readRemembered());
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => setConfirmingClear(false)}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : null}
        <div className={`${CARD} flex flex-col gap-12`}>
          <label htmlFor="owner-key" className="text-14 font-medium">
            {hasRemembered ? 'Or paste your owner key' : 'Owner key'}
          </label>
          <input
            id="owner-key"
            ref={input}
            className={KEY_INPUT}
            type="text"
            placeholder="nsec1... or 64 hex characters"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void pasteKey();
              }
            }}
          />
          <RememberOption ref={remember} id="sign-in" label="Remember my key on this device" />
          <button
            type="button"
            className={BUTTON_PRIMARY}
            disabled={busy}
            onClick={() => void pasteKey()}
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
        </div>
        <div className={`${CARD} flex flex-col gap-8`}>
          <p className="text-15 font-semibold">New to PayCore?</p>
          <p className="text-14 text-text-2">
            Make an owner key for your store. You will see it once, so save it somewhere safe.
          </p>
          <div>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={() => {
                setError('');
                setGenerated(generateOwnerKey());
              }}
            >
              Create an owner key
            </button>
          </div>
        </div>
        <p className="text-13 text-text-3 text-center">
          Running your own node?{' '}
          <a href="/" className={LINK}>
            Sign in with your store key
          </a>
        </p>
      </div>
    </AuthLayout>
  );
}
