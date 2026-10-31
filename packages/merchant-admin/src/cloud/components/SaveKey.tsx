import { useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { Button } from '../../components/Button';

interface Props {
  npub: string;
  onSave: () => void;
  onContinue: () => void;
}

/** A new key is saved before anything else: the console keeps no copy, and no one can restore it. */
export function SaveKey({ npub, onSave, onContinue }: Props) {
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <AuthLayout>
      <div className="rounded-20 border-line bg-surface w-full max-w-520 border p-24 shadow-sm sm:p-32">
        <h1 className="text-24 font-semibold tracking-tight">Save your owner key</h1>
        <p className="text-15 text-text-2 mt-8 leading-relaxed">
          This file is the only copy. Pay Core never sees it and cannot restore it. Without it you
          cannot change where your payments go or open your store here again.
        </p>
        <p className="text-13 text-text-2 mt-16 font-mono break-all">{npub}</p>
        <Button
          onClick={() => {
            onSave();
            setSaved(true);
          }}
          variant="primary"
          size="lg"
          full
          className="mt-24"
        >
          Download the key file
        </Button>
        <label className="text-14 mt-20 flex items-start gap-8">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!saved}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I saved the file somewhere safe and private.
        </label>
        <Button
          disabled={!saved || !confirmed}
          onClick={onContinue}
          size="lg"
          full
          className="mt-16"
        >
          Continue
        </Button>
      </div>
    </AuthLayout>
  );
}
