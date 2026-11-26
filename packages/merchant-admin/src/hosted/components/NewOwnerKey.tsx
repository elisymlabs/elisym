import { type ReactNode, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { BUTTON_PRIMARY, BUTTON_TEXT, CARD } from '../styles';
import { DownloadKey } from './DownloadKey';
import { KeyBlock } from './KeyBlock';

interface Props {
  nsec: string;
  /** Its Owner ID: written in the key file. */
  npub: string;
  onContinue: () => void;
  onCancel: () => void;
  /** Continue is at work (remembering the key): it waits and says so. */
  busy?: boolean;
  /** More choices before Continue, such as remembering the key on this device. */
  children?: ReactNode;
}

/** A new owner key, shown once, to save before going on. */
export function NewOwnerKey({ nsec, npub, onContinue, onCancel, busy = false, children }: Props) {
  const [saved, setSaved] = useState(false);
  return (
    <AuthLayout>
      <div className={`${CARD} flex max-w-560 flex-col gap-20`}>
        <div className="flex flex-col gap-8">
          <h1 className="text-24 font-semibold tracking-tight">Save your owner key</h1>
          <p className="text-15 text-text-2 leading-relaxed">
            PayCore has no accounts or passwords. This key is how you sign in, and it signs your
            payout addresses: keep it like a password. Anyone who has it controls your store, and
            nobody can recover it for you. It is shown only once.
          </p>
        </div>
        <KeyBlock label="Owner key" text={nsec} />
        <DownloadKey nsec={nsec} npub={npub} />
        <div className="flex flex-col gap-10">
          <label className="text-14 flex items-center gap-8">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I saved my key (in a password manager, or the downloaded file)
          </label>
          {children}
        </div>
        <div className="flex flex-col gap-12">
          <button
            type="button"
            className={BUTTON_PRIMARY}
            disabled={!saved || busy}
            onClick={onContinue}
          >
            {busy ? 'Saving on this device...' : 'Continue'}
          </button>
          <button type="button" className={BUTTON_TEXT} disabled={busy} onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </AuthLayout>
  );
}
