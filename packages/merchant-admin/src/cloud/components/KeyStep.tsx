import { useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { Button } from '../../components/Button';
import { type OwnerKey, parseOwnerKey } from '../lib/owner-key';

interface Props {
  onCreate: () => void;
  onKey: (key: OwnerKey) => void;
  /** Back to the admin's front door, before a key is held; none: no way back. */
  onBack?: () => void;
}

/**
 * Make an owner key, or open the console with one: a masked text field outside
 * any form, read once through a ref and cleared (never React state).
 */
export function KeyStep({ onCreate, onKey, onBack }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
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

  const submit = () => {
    const field = input.current;
    if (field === null) {
      return;
    }
    const key = parseOwnerKey(field.value);
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
      <div className="rounded-20 border-line bg-surface w-full max-w-520 border p-24 shadow-sm sm:p-32">
        <h1 className="text-24 font-semibold tracking-tight">Your owner key</h1>
        <p className="text-15 text-text-2 mt-8 leading-relaxed">
          Your owner key signs where your store&apos;s payments go. It is made here, stays in this
          tab&apos;s memory only, and is never sent to our cloud. One key per store.
        </p>
        <Button onClick={onCreate} variant="primary" size="lg" full className="mt-24">
          Create a new owner key
        </Button>
        <div className="mt-28 flex flex-col gap-8">
          <label htmlFor="owner-key" className="text-14 font-medium">
            Or open your store with the key you saved
          </label>
          <input
            id="owner-key"
            ref={input}
            className="masked placeholder:text-text-3 rounded-10 border-line-2 bg-bg text-14 focus:border-accent-ink focus:ring-accent-soft min-w-0 border px-12 py-10 font-mono outline-none focus:ring-4"
            type="text"
            placeholder="nsec1... or 64 hex characters"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="owner-key-error"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
          />
          <p id="owner-key-error" role="alert" className="text-13 text-error empty:hidden">
            {error}
          </p>
          <Button onClick={submit} size="lg">
            Open my store
          </Button>
        </div>
        {onBack === undefined ? null : (
          <Button onClick={onBack} size="sm" className="mt-20">
            Back
          </Button>
        )}
        <p className="text-13 text-text-3 mt-20 leading-relaxed">
          Browser extensions can read what you type into any page. Use a browser profile without
          extensions you do not trust.
        </p>
      </div>
    </AuthLayout>
  );
}
