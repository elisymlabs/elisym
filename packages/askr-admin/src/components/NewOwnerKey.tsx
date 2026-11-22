import { type ReactNode, useState } from 'react';
import { AskrLogo } from './AskrLogo';
import { CopyBlock } from './CopyBlock';
import { DownloadKey } from './DownloadKey';

interface Props {
  nsec: string;
  /** Its Store ID: not shown here, but written in the key file. */
  npub: string;
  heading: string;
  /** Under the heading: what the key is and why it must be saved. */
  lead: ReactNode;
  /** The primary button: "Continue", or "Continue to payment" with a plan chosen. */
  continueLabel: string;
  /** The way back: "Back", or "Already have a store? Sign in". */
  cancelLabel: string;
  onContinue: () => void;
  onCancel: () => void;
  /** Continue is at work (remembering the key): it waits and says so. */
  busy?: boolean;
  /** More choices before Continue, such as remembering the key on this device. */
  children?: ReactNode;
  /** Above the heading: the plan chosen on the landing and the steps, if any. */
  header?: ReactNode;
}

/** A new owner key, shown once, to save before going on. */
export function NewOwnerKey({
  nsec,
  npub,
  heading,
  lead,
  continueLabel,
  cancelLabel,
  onContinue,
  onCancel,
  busy = false,
  children,
  header,
}: Props) {
  const [saved, setSaved] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-20 px-16 py-40">
      <div aria-hidden="true">
        <AskrLogo height={26} />
      </div>
      {header}
      <div className="flex flex-col gap-6">
        <h1 className="text-24 font-semibold">{heading}</h1>
        {lead}
      </div>
      <div className="card flex flex-col gap-16">
        <CopyBlock label="Your key" text={nsec} />
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
        <div className="flex flex-wrap items-center justify-between gap-12 pt-4">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saved || busy}
            onClick={onContinue}
          >
            {busy ? 'Saving on this device...' : continueLabel}
          </button>
          <button
            type="button"
            className="text-13 text-text-2 hover:text-text underline underline-offset-2 disabled:opacity-45"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </main>
  );
}
