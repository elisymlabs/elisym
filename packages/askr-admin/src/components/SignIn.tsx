import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import {
  type Nip07Provider,
  type Signer,
  extensionSigner,
  generateOwnerKey,
  parseSecretKey,
  secretKeySigner,
} from '../lib/signer';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';

interface Props {
  onSigner: (signer: Signer) => void;
  /** The page's NIP-07 extension, looked up when used (extensions inject it late). */
  findExtension: () => Nip07Provider | undefined;
}

/** Sign in with the store owner key O: paste it, use an extension, or make a new one. */
export function SignIn({ onSigner, findExtension }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<ReturnType<typeof generateOwnerKey>>();

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
      setError('That is not a secret key: paste an nsec or 64 hex characters.');
      return;
    }
    setError('');
    onSigner(secretKeySigner(secretKey));
  };

  const useExtension = async () => {
    const extension = findExtension();
    if (extension === undefined) {
      setError('No Nostr signing extension was found in this browser. Paste your key instead.');
      return;
    }
    try {
      onSigner(await extensionSigner(extension));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

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
          Sign in with your store owner key. It stays in this browser tab and is never sent
          anywhere.
        </p>
      </div>
      <div className="card flex flex-col gap-12">
        <label className="field" htmlFor="owner-key">
          <span className="field-label">Owner secret key</span>
          <input
            id="owner-key"
            ref={input}
            className="input masked font-mono"
            type="text"
            placeholder="nsec1... or 64 hex characters"
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
        <button type="button" className="btn" onClick={() => void useExtension()}>
          Sign in with a browser extension
        </button>
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
      </div>
      <div className="card flex flex-col gap-8">
        <p className="text-14 font-medium">New to Askr?</p>
        <p className="text-14 text-text-2">
          Make a new owner key for your store. You will see it once, so save it somewhere safe.
        </p>
        <button type="button" className="btn" onClick={() => setGenerated(generateOwnerKey())}>
          Create a new owner key
        </button>
      </div>
    </main>
  );
}
