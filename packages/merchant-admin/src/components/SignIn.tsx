import { useRef, useState } from 'react';
import { LOCAL_ADMIN_COMMAND, STORE_KEY_COMMAND } from '../constants';
import { type StoreKey, parseStoreKey } from '../lib/core';
import { Code } from './Code';

interface Props {
  onKey: (key: StoreKey) => void;
}

/** The key field: a masked text field outside any form, read once and cleared. */
export function SignIn({ onKey }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const submit = () => {
    const field = input.current;
    if (field === null) {
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
    <main className="mx-auto max-w-560 px-16 py-48 sm:py-80">
      <p className="text-13 text-text-2 font-medium tracking-wide uppercase">elisym</p>
      <h1 className="text-28 mt-8 font-semibold">Store admin</h1>
      <p className="text-text-2 mt-12">
        Paste your store&apos;s secret key to see its orders. The page reads them from your inbox
        relays. <Code>{STORE_KEY_COMMAND}</Code> prints the key.
      </p>

      <div className="rounded-12 border-line bg-surface mt-24 border p-16">
        <label htmlFor="store-key" className="text-14 font-medium">
          Store secret key (nsec or 64 hex)
        </label>
        <div className="mt-8 flex flex-col gap-8 sm:flex-row">
          <input
            id="store-key"
            ref={input}
            className="masked rounded-8 border-line bg-surface-2 text-14 focus:border-text-2 min-w-0 flex-1 border px-12 py-10 font-mono outline-none"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
          />
          <button
            type="button"
            onClick={submit}
            className="rounded-8 bg-accent text-14 text-accent-text px-20 py-10 font-medium hover:opacity-90"
          >
            Open
          </button>
        </div>
        <p role="alert" className="text-14 text-error mt-8 min-h-20">
          {error}
        </p>
      </div>

      <ul className="text-14 text-text-2 mt-24 flex flex-col gap-10">
        <li>
          This key can redirect payments from new buyers. It stays in this tab&apos;s memory only
          and is never sent anywhere. Close the tab when you are done.
        </li>
        <li>
          Browser extensions can read what you type into any page. Use a browser profile without
          extensions you do not trust, or the local admin: <Code>{LOCAL_ADMIN_COMMAND}</Code>.
        </li>
        <li>
          This page&apos;s code is served by elisym on each visit; the local admin runs the version
          you installed.
        </li>
      </ul>
    </main>
  );
}
