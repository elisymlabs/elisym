import { type ReactNode, useState } from 'react';
import { BUTTON_PRIMARY, BUTTON_TEXT } from '../styles';
import { DownloadKey } from './DownloadKey';
import { KeyBlock } from './KeyBlock';

interface Props {
  /** The heading and what the key is for, and that it is shown once. */
  header: ReactNode;
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

/** A new owner key, shown once, to save before going on: Continue waits for "I saved my key". */
export function NewOwnerKeyCard({
  header,
  nsec,
  npub,
  onContinue,
  onCancel,
  busy = false,
  children,
}: Props) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-col gap-20">
      {header}
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
  );
}
