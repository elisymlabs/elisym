import { type ReactNode, useState } from 'react';
import { CopyBlock } from './CopyBlock';
import { DownloadKey } from './DownloadKey';
import { Notice } from './Notice';

interface Props {
  nsec: string;
  npub: string;
  onContinue: () => void;
  onCancel: () => void;
  /** Continue is at work (remembering the key): it waits and says so. */
  busy?: boolean;
  /** More choices before Continue, such as remembering the key on this device. */
  children?: ReactNode;
}

/** A new owner key, shown once, with a clear warning to save it. */
export function NewOwnerKey({ nsec, npub, onContinue, onCancel, busy = false, children }: Props) {
  const [saved, setSaved] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Your new secret key</h1>
      <Notice tone="warn">
        Save this secret key now, in a password manager or on paper. It is shown only once. Anyone
        who has it controls your store, and nobody can recover it for you if you lose it.
      </Notice>
      <div className="card flex flex-col gap-16">
        <CopyBlock label="Secret key (keep private)" text={nsec} />
        <CopyBlock label="Store ID (public: it names your store in the chat code)" text={npub} />
        <DownloadKey nsec={nsec} npub={npub} />
        <label className="text-14 flex items-center gap-8">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          I saved the secret key somewhere safe
        </label>
        {children}
        <div className="flex gap-8">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saved || busy}
            onClick={onContinue}
          >
            {busy ? 'Saving on this device...' : 'Continue'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
