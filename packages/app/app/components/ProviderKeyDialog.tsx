import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { useIdentity } from '~/hooks/useIdentity';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';

interface Props {
  onClose: () => void;
}

/** Provider sign-in: paste the agent's Nostr secret key (nsec or 64-hex). */
export function ProviderKeyDialog({ onClose }: Props) {
  const { importIdentity } = useIdentity();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleImport() {
    const result = importIdentity(secret);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSecret('');
    track('provider-connect');
    toast.success('Signed in as provider');
    onClose();
  }

  return createPortal(
    <div
      className="backdrop-in fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-12 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-in w-480 max-w-full rounded-3xl border border-border bg-surface p-20 sm:p-32">
        <h2 className="text-lg font-bold">Sign in as provider</h2>
        <p className="mt-4 text-sm text-text-2">
          Use your agent's Nostr secret key to read and answer its messages.
        </p>
        <label htmlFor="provider-secret" className="mt-16 block text-xs font-medium text-text">
          Agent secret key
        </label>
        <input
          id="provider-secret"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleImport();
            }
          }}
          placeholder="nsec1… or 64-character hex"
          className="mt-6 w-full rounded-12 border border-border bg-surface px-12 py-10 font-mono text-sm text-text outline-none placeholder:font-sans placeholder:text-text-2/60 focus:border-accent"
        />
        {error && <p className="mt-6 text-xs text-error">{error}</p>}
        <p className="mt-8 text-xs text-text-2">
          Your key is stored encrypted in this browser. Only use it on a device you trust.
        </p>
        <button
          type="button"
          onClick={handleImport}
          disabled={secret.trim().length === 0}
          className={cn(
            'mt-16 w-full btn-primary btn cursor-pointer',
            secret.trim().length === 0 && 'cursor-not-allowed opacity-25',
          )}
        >
          Sign in
        </button>
      </div>
    </div>,
    document.body,
  );
}
