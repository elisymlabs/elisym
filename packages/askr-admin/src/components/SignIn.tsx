import { useEffect, useRef, useState } from 'react';
import { forgetDamaged, nextTask, readRemembered, rememberKey } from '../lib/remembered';
import { type Signer, generateOwnerKey, parseSecretKey, secretKeySigner } from '../lib/signer';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { RecoverStore } from './RecoverStore';
import { type RememberChoice, type RememberHandle, RememberOption } from './RememberOption';
import { UnlockRemembered } from './UnlockRemembered';

interface Props {
  onSigner: (signer: Signer) => void;
  /** Move a store to a new key (K21); the server checks the store's site, or all but it. */
  recover: (signer: Signer, from: string, dryRun: boolean) => Promise<void>;
  /** Open on replacing the key of this store (Store ID), as the admin's own button does. */
  replaceKeyOf?: string;
}

const NOT_REMEMBERED =
  'Your secret key could not be remembered on this device. To go on without it, clear the remember box and try again.';

/** Lock and remember `secretKey` with `password`: undefined when done, else what to tell them. */
async function rememberWith(secretKey: Uint8Array, password: string): Promise<string | undefined> {
  await nextTask();
  return rememberKey(secretKey, password) ? undefined : NOT_REMEMBERED;
}

/**
 * Sign in with the store's secret key, unlock one this device remembers, make
 * a new one, or replace a lost one.
 */
export function SignIn({ onSigner, recover, replaceKeyOf }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const remember = useRef<RememberHandle>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<ReturnType<typeof generateOwnerKey>>();
  const [recovering, setRecovering] = useState(replaceKeyOf !== undefined);
  const [remembered, setRemembered] = useState(readRemembered);

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

  /** Sign in as `secretKey`, after remembering it on this device when chosen. */
  const signInAs = async (secretKey: Uint8Array, choice: RememberChoice) => {
    if (choice.kind === 'on') {
      setBusy(true);
      setError('');
      const problem = await rememberWith(secretKey, choice.password);
      setBusy(false);
      if (problem !== undefined) {
        setError(problem);
        return;
      }
    }
    setError('');
    onSigner(secretKeySigner(secretKey));
  };

  /** What the merchant chose about remembering, or undefined after showing why it cannot be. */
  const rememberChoice = (): RememberChoice | undefined => {
    const choice = remember.current?.read() ?? { kind: 'off' };
    if (choice.kind === 'invalid') {
      setError(choice.message);
      return undefined;
    }
    return choice;
  };

  const pasteKey = () => {
    const field = input.current;
    if (field === null || busy) {
      return;
    }
    const secretKey = parseSecretKey(field.value);
    if (secretKey === undefined) {
      field.value = '';
      setError('That is not a secret key: it starts with nsec1.');
      return;
    }
    // A password problem keeps the pasted key, so fixing the password needs no second paste.
    const choice = rememberChoice();
    if (choice === undefined) {
      return;
    }
    field.value = '';
    void signInAs(secretKey, choice);
  };

  const continueWithNew = (secretKey: Uint8Array) => {
    const choice = busy ? undefined : rememberChoice();
    if (choice !== undefined) {
      void signInAs(secretKey, choice);
    }
  };

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
        onContinue={() => continueWithNew(generated.secretKey)}
        onCancel={() => {
          setGenerated(undefined);
          setError('');
        }}
      >
        <RememberOption ref={remember} id="new-key" label="Remember this key on this device" />
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
      </NewOwnerKey>
    );
  }

  const hasRemembered = remembered.keys.length > 0;
  return (
    <main className="mx-auto flex min-h-screen max-w-520 flex-col justify-center gap-20 px-16 py-40">
      <div className="flex flex-col gap-6">
        <h1 className="text-24 font-semibold">Askr admin</h1>
        <p className="text-15 text-text-2">
          Sign in with your store&apos;s secret key. It is never sent anywhere: it stays in this
          browser tab, and on this device only if you choose to remember it with a password.
        </p>
      </div>
      {hasRemembered ? (
        <UnlockRemembered
          keys={remembered.keys}
          onUnlocked={(secretKey) => {
            const signer = secretKeySigner(secretKey);
            secretKey.fill(0);
            onSigner(signer);
          }}
          onForgotten={() => setRemembered(readRemembered())}
        />
      ) : null}
      {remembered.damaged ? (
        <Notice tone="warn">
          A key remembered on this device could not be read, so it is not offered. Sign in with your
          secret key.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              forgetDamaged();
              setRemembered(readRemembered());
            }}
          >
            Clear it
          </button>
        </Notice>
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
