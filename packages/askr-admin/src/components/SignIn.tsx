import { useEffect, useRef, useState } from 'react';
import type { PlanIntent } from '../lib/plan-intent';
import { type RememberedRead, forgetDamaged, readRemembered, rememberKey } from '../lib/remembered';
import {
  type OwnerKey,
  type Signer,
  generateOwnerKey,
  parseSecretKey,
  secretKeySigner,
} from '../lib/signer';
import { tabSignedInStore } from '../lib/tab-session';
import { AskrLogo } from './AskrLogo';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { PlanChoiceLine } from './PlanChoiceLine';
import { PlanSteps } from './PlanSteps';
import { RecoverStore } from './RecoverStore';
import { type RememberChoice, type RememberHandle, RememberOption } from './RememberOption';
import { UnlockRemembered } from './UnlockRemembered';

interface Props {
  onSigner: (signer: Signer) => void;
  /** Move a store to a new key (K21); the server checks the store's site, or all but it. */
  recover: (signer: Signer, from: string, dryRun: boolean) => Promise<void>;
  /** Open on replacing the key of this store (Store ID), as the admin's own button does. */
  replaceKeyOf?: string;
  /** The paid plan chosen on the landing (D3): said before the key, to be paid for after it. */
  intent?: PlanIntent;
  onDismissIntent?: () => void;
}

const NOT_REMEMBERED =
  'Your secret key could not be remembered on this device. To go on without it, clear the remember box and try again.';

const NEW_KEY_LEAD =
  'Askr has no accounts or passwords. This key is how you sign in: keep it like a password. Anyone who has it controls your store, and nobody can recover it for you. It is shown only once.';

/**
 * Whether a visitor opens straight on a new key: a plan was chosen on the landing, and nothing
 * says they already have a store here (no key remembered or unreadable on this device, none a
 * newer admin remembered, no tab signed in before a reload), and no key is being replaced.
 */
function opensOnNewKey(
  intent: PlanIntent | undefined,
  replaceKeyOf: string | undefined,
  remembered: RememberedRead,
): boolean {
  return (
    intent !== undefined &&
    replaceKeyOf === undefined &&
    remembered.keys.length === 0 &&
    !remembered.damaged &&
    remembered.newer !== true &&
    tabSignedInStore() === undefined
  );
}

/** Remember `secretKey` on this device: undefined when done, else what to tell them. */
async function rememberOnDevice(secretKey: Uint8Array): Promise<string | undefined> {
  return (await rememberKey(secretKey)) ? undefined : NOT_REMEMBERED;
}

/**
 * Sign in with the store's secret key, unlock one this device remembers, make
 * a new one, or replace a lost one.
 */
export function SignIn({
  onSigner,
  recover,
  replaceKeyOf,
  intent,
  onDismissIntent = () => undefined,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const remember = useRef<RememberHandle>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Set at once on a press, before React re-renders: a double press remembers and signs in once. */
  const working = useRef(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [recovering, setRecovering] = useState(replaceKeyOf !== undefined);
  const [remembered, setRemembered] = useState(readRemembered);
  // Made once, in the initializer, so a re-render (or StrictMode's second one) shows the same key.
  const [generated, setGenerated] = useState<OwnerKey | undefined>(() =>
    opensOnNewKey(intent, replaceKeyOf, remembered) ? generateOwnerKey() : undefined,
  );

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
   * `beforeSignIn` runs only once nothing is left to retry (it clears the key field).
   */
  const signInAs = async (
    secretKey: Uint8Array,
    choice: RememberChoice,
    beforeSignIn: () => void,
  ) => {
    working.current = true;
    try {
      if (choice.kind === 'on') {
        setBusy(true);
        setError('');
        const problem = await rememberOnDevice(secretKey);
        if (problem !== undefined) {
          setError(
            remembered.damaged ? `${problem} Or clear what could not be read first.` : problem,
          );
          return;
        }
      }
      setError('');
      beforeSignIn();
      onSigner(secretKeySigner(secretKey));
    } catch {
      setError('That secret key could not be used. Check it and try again.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const rememberChoice = (): RememberChoice => remember.current?.read() ?? { kind: 'off' };

  const pasteKey = () => {
    const field = input.current;
    if (field === null || working.current) {
      return;
    }
    const secretKey = parseSecretKey(field.value);
    if (secretKey === undefined) {
      field.value = '';
      setError('That is not a secret key: it starts with nsec1.');
      return;
    }
    // A storage problem keeps the pasted key, so a retry needs no second paste
    // (the field is still cleared when the page is hidden).
    void signInAs(secretKey, rememberChoice(), () => {
      field.value = '';
    });
  };

  const continueWithNew = (secretKey: Uint8Array) => {
    if (!working.current) {
      void signInAs(secretKey, rememberChoice(), () => undefined);
    }
  };

  const intentLine =
    intent === undefined ? null : <PlanChoiceLine intent={intent} onDismiss={onDismissIntent} />;

  if (recovering) {
    return (
      <RecoverStore
        storeId={replaceKeyOf ?? ''}
        recover={recover}
        onDone={onSigner}
        onCancel={() => {
          setRecovering(false);
          setRemembered(readRemembered());
        }}
      />
    );
  }

  if (generated !== undefined) {
    return (
      <NewOwnerKey
        nsec={generated.nsec}
        npub={generated.npub}
        heading="Save your key"
        lead={<p className="text-15 text-text-2">{NEW_KEY_LEAD}</p>}
        continueLabel={intent === undefined ? 'Continue' : 'Continue to payment'}
        cancelLabel={intent === undefined ? 'Back' : 'Already have a store? Sign in'}
        busy={busy}
        onContinue={() => continueWithNew(generated.secretKey)}
        onCancel={() => {
          setGenerated(undefined);
          setError('');
        }}
        header={
          intent === undefined ? null : (
            <div className="flex flex-col gap-16">
              {intentLine}
              <PlanSteps current={1} />
            </div>
          )
        }
      >
        <RememberOption ref={remember} id="new-key" label="Keep me signed in on this device" />
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
      </NewOwnerKey>
    );
  }

  const hasRemembered = remembered.keys.length > 0;
  return (
    <main className="mx-auto flex min-h-screen max-w-440 flex-col justify-center gap-24 px-16 py-40">
      <div className="flex flex-col items-center gap-8 text-center">
        <h1 className="mb-4">
          <AskrLogo height={34} />
          <span className="sr-only">Askr admin</span>
        </h1>
        <p className="text-14 text-text-2">
          Sign in with your store&apos;s secret key. It is never sent anywhere: it stays in this
          browser tab, and on this device unless you clear the remember box.
        </p>
      </div>
      {intentLine}
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
          it; until then, sign in with your secret key.
        </Notice>
      ) : null}
      {remembered.damaged && !confirmingClear ? (
        <Notice tone="warn">
          A key remembered on this device could not be read, so it is not offered. Sign in with your
          secret key.{' '}
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
              className="btn btn-primary"
              onClick={() => {
                forgetDamaged();
                setConfirmingClear(false);
                setRemembered(readRemembered());
              }}
            >
              Clear
            </button>
            <button type="button" className="btn" onClick={() => setConfirmingClear(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      <div className="card flex flex-col gap-12">
        {hasRemembered ? (
          <p className="text-14 font-medium">Or sign in with your secret key</p>
        ) : null}
        <label className="field" htmlFor="owner-key">
          <span className="field-label">Secret key</span>
          <input
            id="owner-key"
            ref={input}
            className="input masked font-mono"
            type="text"
            placeholder="nsec1..."
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                pasteKey();
              }
            }}
          />
        </label>
        <RememberOption ref={remember} id="sign-in" label="Remember my key on this device" />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={pasteKey}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        <button type="button" className="text-14 underline" onClick={() => setRecovering(true)}>
          Lost your secret key?
        </button>
      </div>
      <div className="card flex flex-col gap-8">
        <p className="text-14 font-medium">New to Askr?</p>
        <p className="text-14 text-text-2">
          Make a secret key for your store. You will see it once, so save it somewhere safe.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setError('');
            setGenerated(generateOwnerKey());
          }}
        >
          Create a secret key
        </button>
      </div>
    </main>
  );
}
