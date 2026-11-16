import { useEffect, useRef, useState } from 'react';
import { type Signer, generateOwnerKey, parseSecretKey, secretKeySigner } from '../lib/signer';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { RecoverStore } from './RecoverStore';

interface Props {
  onSigner: (signer: Signer) => void;
  /** Move a store to a new key (K20); the server checks the store's site. */
  recover: (signer: Signer, from: string) => Promise<void>;
  /** Open on replacing the key of this store (Store ID), as the admin's own button does. */
  replaceKeyOf?: string;
}

/** Sign in with the store's secret key, make a new one, or replace a lost one. */
export function SignIn({ onSigner, recover, replaceKeyOf }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<ReturnType<typeof generateOwnerKey>>();
  const [recovering, setRecovering] = useState(replaceKeyOf !== undefined);

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

  const pasteKey = () => {
    const field = input.current;
    if (field === null) {
      return;
    }
    const secretKey = parseSecretKey(field.value);
    field.value = '';
    if (secretKey === undefined) {
      setError('That is not a secret key: it starts with nsec1.');
      return;
    }
    setError('');
    onSigner(secretKeySigner(secretKey));
  };

  if (recovering) {
    return (
      <RecoverStore
        storeId={replaceKeyOf ?? ''}
        recover={recover}
        onDone={onSigner}
        onCancel={() => setRecovering(false)}
      />
    );
  }

  if (generated !== undefined) {
    return (
      <NewOwnerKey
        nsec={generated.nsec}
        npub={generated.npub}
        onContinue={() => onSigner(secretKeySigner(generated.secretKey))}
        onCancel={() => setGenerated(undefined)}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-520 flex-col justify-center gap-20 px-16 py-40">
      <div className="flex flex-col gap-6">
        <h1 className="text-24 font-semibold">Askr admin</h1>
        <p className="text-15 text-text-2">
          Sign in with your store&apos;s secret key. It stays in this browser tab and is never sent
          anywhere.
        </p>
      </div>
      <div className="card flex flex-col gap-12">
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
        <button type="button" className="btn btn-primary" onClick={pasteKey}>
          Sign in
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
        <button type="button" className="btn" onClick={() => setGenerated(generateOwnerKey())}>
          Create a secret key
        </button>
      </div>
    </main>
  );
}
