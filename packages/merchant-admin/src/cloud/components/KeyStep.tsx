import { AuthLayout } from '../../components/AuthLayout';
import { Button } from '../../components/Button';

interface Props {
  onCreate: () => void;
  /** To the admin's one sign-in field, which routes a saved key. */
  onSignIn: () => void;
  /** Back to the admin's front door, before a key is held; none: no way back. */
  onBack?: () => void;
}

/** Make an owner key here, or go to the one sign-in with the key saved before. */
export function KeyStep({ onCreate, onSignIn, onBack }: Props) {
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
          <p className="text-14 font-medium">Made one already?</p>
          <Button onClick={onSignIn} size="lg">
            Sign in with the key you saved
          </Button>
        </div>
        {onBack === undefined ? null : (
          <Button onClick={onBack} size="sm" className="mt-20">
            Back
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
