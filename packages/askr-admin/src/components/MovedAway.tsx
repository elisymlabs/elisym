import { ForgetOnDevice } from './ForgetOnDevice';
import { Notice } from './Notice';

interface Props {
  onTakeBack: () => void;
  onSignOut: () => void;
  /** The key signed in with (hex), which this device may still remember. */
  store: string;
}

/** Signed in with a key the store moved away from (K21): sign in with the new one, or take it back. */
export function MovedAway({ onTakeBack, onSignOut, store }: Props) {
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Your store moved to another secret key</h1>
      <Notice tone="warn">
        This secret key was replaced, so it opens no store any more. If you replaced it, sign in
        with your new key. If you did not, someone else may have had this key: take your store back
        through your site.
      </Notice>
      <div className="flex gap-8">
        <button type="button" className="btn btn-primary" onClick={onTakeBack}>
          Take my store back
        </button>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
      <ForgetOnDevice store={store} />
    </main>
  );
}
