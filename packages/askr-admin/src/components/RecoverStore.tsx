import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { forgetKey, rememberKey } from '../lib/remembered';
import {
  type OwnerKey,
  type Signer,
  generateOwnerKey,
  ownerKeyOf,
  parsePublicKey,
  parseSecretKey,
  secretKeySigner,
} from '../lib/signer';
import { CopyBlock } from './CopyBlock';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { type RememberHandle, RememberOption } from './RememberOption';
import { TextField } from './TextField';

interface Props {
  /** The Store ID to start from, when the merchant came from their admin. */
  storeId: string;
  /**
   * Move the store with owner key `from` to `signer`'s key (the server checks
   * the site); `dryRun` checks all but the site.
   */
  recover: (signer: Signer, from: string, dryRun: boolean) => Promise<void>;
  onDone: (signer: Signer) => void;
  onCancel: () => void;
}

const NOT_FORGOTTEN =
  'This browser did not let the admin forget the old key on this device: it opens no store any more, so forget it from the sign-in page later.';
const NOT_REMEMBERED =
  'This browser did not let the admin remember the new key on this device. Keep the new key you saved: you sign in with it next time.';

/** What to say when the store moved but this device did not record it fully. */
function movedProblem(forgot: boolean, remembered: boolean): string {
  const problems = [forgot ? '' : NOT_FORGOTTEN, remembered ? '' : NOT_REMEMBERED].filter(
    (problem) => problem !== '',
  );
  return `Your store moved to the new key. ${problems.join(' ')}`;
}

type Step =
  | { step: 'store' }
  | { step: 'key'; from: string; key: OwnerKey }
  | { step: 'proof'; from: string; key: OwnerKey }
  /** Moved, but this device refused to forget the old key or remember the new one. */
  | { step: 'moved'; signer: Signer; problem: string };

/**
 * Replace a lost or leaked secret key (K21): a new key is made here (or one
 * made earlier is pasted), the merchant puts its Store ID on their site, and
 * the server moves the store to it. What stands in the way is checked before
 * the key is shown, so nobody edits their site for nothing.
 */
export function RecoverStore({ storeId, recover, onDone, onCancel }: Props) {
  const [state, setState] = useState<Step>({ step: 'store' });
  const [typed, setTyped] = useState(storeId);
  const [haveKey, setHaveKey] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const remember = useRef<RememberHandle>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Leaving the page keeps it in the back/forward cache: a typed key must not come back.
  useEffect(() => {
    const clear = () => {
      if (keyInput.current !== null) {
        keyInput.current.value = '';
      }
    };
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, []);

  if (state.step === 'key') {
    return (
      <NewOwnerKey
        nsec={state.key.nsec}
        npub={state.key.npub}
        heading="Your new secret key"
        lead={
          <Notice tone="warn">
            Save this secret key now, in a password manager or on paper. It is shown only once.
            Anyone who has it controls your store, and nobody can recover it for you if you lose it.
          </Notice>
        }
        continueLabel="Continue"
        cancelLabel="Back"
        onContinue={() => setState({ step: 'proof', from: state.from, key: state.key })}
        onCancel={() => setState({ step: 'store' })}
      />
    );
  }

  if (state.step === 'moved') {
    const { signer, problem } = state;
    return (
      <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
        <h1 className="text-24 font-semibold">Your store moved</h1>
        <Notice tone="warn">{problem}</Notice>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => onDone(signer)}>
            Continue
          </button>
        </div>
      </main>
    );
  }

  if (state.step === 'proof') {
    const { from, key } = state;
    const move = async () => {
      const choice = remember.current?.read() ?? { kind: 'off' };
      setBusy(true);
      setError('');
      const signer = secretKeySigner(key.secretKey);
      try {
        await recover(signer, from, false);
      } catch (failure) {
        setError(errorMessage(failure));
        setBusy(false);
        return;
      }
      // The old key opens no store any more: this device stops remembering it either way.
      const forgot = forgetKey(from);
      let remembered = true;
      if (choice.kind === 'on') {
        remembered = await rememberKey(key.secretKey);
      }
      setBusy(false);
      if (forgot && remembered) {
        onDone(signer);
        return;
      }
      setState({
        step: 'moved',
        signer,
        problem: movedProblem(forgot, remembered),
      });
    };
    return (
      <main className="mx-auto flex min-h-screen max-w-640 flex-col justify-center gap-16 px-16 py-40">
        <h1 className="text-24 font-semibold">Prove the store is yours</h1>
        <p className="text-15 text-text-2">
          Add one of these to the site your assistant runs on, then press the button below. Your new
          Store ID is not secret. Keep it on your site: a connector to your shop checks it too.
        </p>
        <div className="card flex flex-col gap-16">
          <CopyBlock
            label="Either: this tag in the <head> of your home page"
            text={`<meta name="askr-verification" content="${key.npub}">`}
          />
          <CopyBlock
            label="Or: a file at /.well-known/askr on your site, with this line in it"
            text={key.npub}
          />
          <p className="text-13 text-text-2">
            Only a site your store has listed for at least three days counts, so someone who stole
            your key cannot add a site of their own and take the store.
          </p>
          <RememberOption
            ref={remember}
            id="moved-key"
            label="Remember the new key on this device once the store moved"
          />
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div className="flex gap-8">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void move()}
            >
              {busy ? 'Checking your site...' : 'Check my site and move the store'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </main>
    );
  }

  const next = async () => {
    const from = parsePublicKey(typed);
    if (from === undefined) {
      setError('That is not a Store ID: it starts with npub1.');
      return;
    }
    let key: OwnerKey;
    if (haveKey) {
      const field = keyInput.current;
      const secretKey = field === null ? undefined : parseSecretKey(field.value);
      if (field !== null) {
        field.value = '';
      }
      if (secretKey === undefined) {
        setError('That is not a secret key: it starts with nsec1.');
        return;
      }
      key = ownerKeyOf(secretKey);
    } else {
      key = generateOwnerKey();
    }
    setBusy(true);
    setError('');
    try {
      await recover(secretKeySigner(key.secretKey), from, true);
      setState(haveKey ? { step: 'proof', from, key } : { step: 'key', from, key });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Replace your secret key</h1>
      <p className="text-15 text-text-2">
        Lost your secret key, or think someone else has it? Make a new one and move your store to
        it. Your products, policies, plan and chat code stay; the old key stops working.
      </p>
      <div className="card flex flex-col gap-12">
        <TextField
          id="recover-store"
          label="Your Store ID"
          value={typed}
          placeholder="npub1..."
          hint='It is in the chat code on your site, after data-store=" or store="'
          onChange={setTyped}
        />
        <label className="text-14 flex items-center gap-8">
          <input
            type="checkbox"
            checked={haveKey}
            onChange={(event) => setHaveKey(event.target.checked)}
          />
          I already made and saved a new secret key here
        </label>
        {haveKey ? (
          <label className="field" htmlFor="recover-key">
            <span className="field-label">Your new secret key</span>
            <input
              id="recover-key"
              ref={keyInput}
              className="input masked font-mono"
              type="text"
              placeholder="nsec1..."
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        ) : null}
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        <div className="flex gap-8">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void next()}
          >
            {busy ? 'Checking...' : 'Continue'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
