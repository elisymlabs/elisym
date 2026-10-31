import { useEffect, useRef, useState } from 'react';
import { QUICKSTART_URL, STORE_KEY_COMMAND } from '../constants';
import { type StoreKey, parseStoreKey } from '../lib/core';
import { AuthLayout } from './AuthLayout';
import { CommandLine } from './CommandLine';
import { TrustPanel } from './TrustPanel';

interface Props {
  onKey: (key: StoreKey) => void;
  /**
   * The cloud is on: the field takes a cloud store's owner key too, the answer
   * is waited on (`checking`), and why the key opened nothing is said.
   */
  cloud?: { checking: boolean; problem: string; onBack: () => void };
}

/** The key field: a masked text field outside any form, read once and cleared. */
export function SignIn({ onKey, cloud }: Props) {
  const input = useRef<HTMLInputElement>(null);
  // Leaving by a link keeps this page in the back/forward cache: a typed key must not come back.
  useEffect(() => {
    const clear = () => {
      if (input.current !== null) {
        input.current.value = '';
      }
    };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);
  const [error, setError] = useState('');

  const checking = cloud?.checking === true;
  const submit = () => {
    const field = input.current;
    // While a key is being routed, the field keeps what was typed: nothing is read twice.
    if (field === null || checking) {
      return;
    }
    const key = parseStoreKey(field.value);
    field.value = '';
    if (key === undefined) {
      setError('That is not a secret key: paste an nsec or 64 hex characters.');
      return;
    }
    setError('');
    onKey(key);
  };

  return (
    <AuthLayout>
      <div className="grid w-full max-w-960 items-start gap-24 lg:grid-cols-[1.1fr_0.9fr]">
        <div
          aria-busy={checking}
          className="rounded-20 border-line bg-surface border p-24 shadow-sm sm:p-32"
        >
          <h1 className="text-24 font-semibold tracking-tight">Sign in to your store</h1>
          <p className="text-15 text-text-2 mt-8">
            {cloud === undefined
              ? 'Open your orders, products and store profile with your store key.'
              : 'For a store in our cloud, paste its owner key (the file you saved when you made it). For a store you run yourself, its store key.'}
          </p>
          {cloud === undefined ? null : (
            <p className="text-13 text-text-3 mt-8">
              We ask our cloud whether this key runs a store there, and read your relays; the key
              itself never leaves this page.
            </p>
          )}

          <ol className="mt-28 flex flex-col gap-20">
            <li className="flex gap-12">
              <span className="bg-surface-2 text-13 grid size-24 shrink-0 place-items-center rounded-full font-semibold">
                1
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-8">
                <p className="text-14 font-medium">
                  {cloud === undefined ? null : 'A store you run yourself: '}
                  On the machine that runs your node, print the store key
                </p>
                <CommandLine command={STORE_KEY_COMMAND} />
              </div>
            </li>
            <li className="flex gap-12">
              <span className="bg-surface-2 text-13 grid size-24 shrink-0 place-items-center rounded-full font-semibold">
                2
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-8">
                <label htmlFor="store-key" className="text-14 font-medium">
                  Paste it here
                </label>
                <input
                  id="store-key"
                  ref={input}
                  className="masked placeholder:text-text-3 rounded-10 border-line-2 bg-bg text-14 focus:border-accent-ink focus:ring-accent-soft min-w-0 border px-12 py-10 font-mono outline-none focus:ring-4"
                  type="text"
                  placeholder="nsec1... or 64 hex characters"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="store-key-error"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submit();
                    }
                  }}
                />
                <p
                  id="store-key-error"
                  role="alert"
                  className="text-13 text-error min-h-18 empty:min-h-0"
                >
                  {error === '' ? (cloud?.problem ?? '') : error}
                </p>
              </div>
            </li>
          </ol>

          <button
            type="button"
            onClick={submit}
            aria-disabled={checking}
            className="rounded-10 bg-ink text-15 text-ink-text mt-8 w-full py-12 font-semibold transition hover:opacity-90 aria-disabled:opacity-50"
          >
            {checking ? 'Opening your store...' : 'Open store'}
          </button>
          {cloud === undefined ? null : (
            <p role="status" className="sr-only">
              {checking ? 'Opening your store...' : ''}
            </p>
          )}
          {cloud === undefined ? null : (
            <button
              type="button"
              onClick={cloud.onBack}
              className="text-13 text-text-2 hover:text-text mt-12 w-full underline underline-offset-2"
            >
              Back
            </button>
          )}
          <p className="text-13 text-text-3 mt-16 text-center">
            No store yet?{' '}
            <a
              href={QUICKSTART_URL}
              rel="noopener noreferrer"
              className="text-text-2 hover:text-text underline underline-offset-2"
            >
              Start one in the quickstart
            </a>
          </p>
        </div>

        <TrustPanel />
      </div>
    </AuthLayout>
  );
}
