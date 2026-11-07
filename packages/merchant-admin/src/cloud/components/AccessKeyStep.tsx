import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';

interface Props {
  /** The access key made in this session (its public id), or none yet. */
  made: { npub: string } | undefined;
  /** The key file was handed to the browser. */
  saved: boolean;
  /** The merchant ticked "I saved it". */
  confirmed: boolean;
  onCreate: () => void;
  onSave: () => void;
  onConfirm: (confirmed: boolean) => void;
  onContinue: () => void;
  /** To the one sign-in field, with a key saved before: offered only while none is made here. */
  onSignIn: () => void;
}

/**
 * The access key, made and saved on one screen: once made it stays the key of
 * this visit (no second one), and Continue waits for the file and the tick.
 */
export function AccessKeyStep({
  made,
  saved,
  confirmed,
  onCreate,
  onSave,
  onConfirm,
  onContinue,
  onSignIn,
}: Props) {
  // Once the key is made, the next thing to do is to save it: focus goes there.
  const download = useRef<HTMLButtonElement>(null);
  const isMade = made !== undefined;
  useEffect(() => {
    if (isMade) {
      download.current?.focus();
    }
  }, [isMade]);
  return (
    <div className="flex flex-col gap-16">
      <p className="text-15 text-text-2 leading-relaxed">
        Your access key is your password for this admin. It is made here, in your browser: we never
        see it and cannot restore it, so you download it as a file and keep it safe.
      </p>
      {made === undefined ? (
        <>
          <Button onClick={onCreate} variant="primary" size="lg" full>
            Create my access key
          </Button>
          <p className="text-13 text-text-3">
            I already have one:{' '}
            <button
              type="button"
              onClick={onSignIn}
              className="text-text-2 hover:text-text underline underline-offset-2"
            >
              sign in
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="text-13 text-text-3">
            Your access key&apos;s public id (safe to share):
            <span className="text-text-2 mt-4 block font-mono break-all">{made.npub}</span>
          </p>
          <Button
            ref={download}
            onClick={onSave}
            variant={saved ? 'secondary' : 'primary'}
            size="lg"
            full
          >
            Download the key file
          </Button>
          <label className="text-14 flex items-start gap-8">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!saved}
              onChange={(event) => onConfirm(event.target.checked)}
            />
            I saved the file somewhere safe and private.
          </label>
          <Button
            disabled={!saved || !confirmed}
            onClick={onContinue}
            variant="primary"
            size="lg"
            full
          >
            Continue
          </Button>
        </>
      )}
    </div>
  );
}
