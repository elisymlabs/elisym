import { useState } from 'react';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';

interface Props {
  nsec: string;
  npub: string;
  onContinue: () => void;
  onCancel: () => void;
}

/** A new owner key, shown once, with a clear warning to save it. */
export function NewOwnerKey({ nsec, npub, onContinue, onCancel }: Props) {
  const [saved, setSaved] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Your new owner key</h1>
      <Notice tone="warn">
        Save this secret key now, in a password manager or on paper. It is shown only once. Anyone
        who has it controls your store, and nobody can recover it for you if you lose it.
      </Notice>
      <div className="card flex flex-col gap-16">
        <CopyBlock label="Secret key (keep private)" text={nsec} />
        <CopyBlock label="Store ID (public, goes in the embed code)" text={npub} />
        <label className="text-14 flex items-center gap-8">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          I saved the secret key somewhere safe
        </label>
        <div className="flex gap-8">
          <button type="button" className="btn btn-primary" disabled={!saved} onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
