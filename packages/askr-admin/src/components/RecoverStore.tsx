import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import { type Signer, generateOwnerKey, parsePublicKey, secretKeySigner } from '../lib/signer';
import { CopyBlock } from './CopyBlock';
import { NewOwnerKey } from './NewOwnerKey';
import { Notice } from './Notice';
import { TextField } from './TextField';

interface Props {
  /** The Store ID to start from, when the merchant came from their admin. */
  storeId: string;
  /** Move the store with owner key `from` to `signer`'s key (the server checks the site). */
  recover: (signer: Signer, from: string) => Promise<void>;
  onDone: (signer: Signer) => void;
  onCancel: () => void;
}

type Step =
  | { step: 'store' }
  | { step: 'key'; from: string; key: ReturnType<typeof generateOwnerKey> }
  | { step: 'proof'; from: string; key: ReturnType<typeof generateOwnerKey> };

/**
 * Replace a lost or leaked secret key (K20): a new key is made here, the
 * merchant puts its Store ID on their site, and the server moves the store to
 * it. Products, policies, the plan and the chat history stay.
 */
export function RecoverStore({ storeId, recover, onDone, onCancel }: Props) {
  const [state, setState] = useState<Step>({ step: 'store' });
  const [typed, setTyped] = useState(storeId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (state.step === 'key') {
    return (
      <NewOwnerKey
        nsec={state.key.nsec}
        npub={state.key.npub}
        onContinue={() => setState({ step: 'proof', from: state.from, key: state.key })}
        onCancel={() => setState({ step: 'store' })}
      />
    );
  }

  if (state.step === 'proof') {
    const { from, key } = state;
    const move = async () => {
      setBusy(true);
      setError('');
      const signer = secretKeySigner(key.secretKey);
      try {
        await recover(signer, from);
        onDone(signer);
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    };
    return (
      <main className="mx-auto flex min-h-screen max-w-640 flex-col justify-center gap-16 px-16 py-40">
        <h1 className="text-24 font-semibold">Prove the store is yours</h1>
        <p className="text-15 text-text-2">
          Add one of these to the site your assistant runs on, then press the button below. Your new
          Store ID is not secret. Keep it on the site until the move is done; you may remove it
          afterwards.
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

  const next = () => {
    const from = parsePublicKey(typed);
    if (from === undefined) {
      setError('That is not a Store ID: it starts with npub1.');
      return;
    }
    setError('');
    setState({ step: 'key', from, key: generateOwnerKey() });
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Replace your secret key</h1>
      <p className="text-15 text-text-2">
        Lost your secret key, or think someone else has it? Make a new one and move your store to
        it. Your products, policies, plan and chat history stay; the old key stops working.
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
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        <div className="flex gap-8">
          <button type="button" className="btn btn-primary" onClick={next}>
            Make a new secret key
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
