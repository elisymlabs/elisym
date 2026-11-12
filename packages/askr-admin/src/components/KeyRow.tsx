import { useState } from 'react';
import { Notice } from './Notice';

interface Props {
  npub: string;
  roles: string[];
  /** What the store uses this key for now, if anything. */
  uses: string[];
  revocable: boolean;
  busy: boolean;
  onRevoke: () => Promise<void>;
}

/** One authorized key; revoking asks first, louder when the store relies on the key. */
export function KeyRow({ npub, roles, uses, revocable, busy, onRevoke }: Props) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="border-line rounded-10 flex flex-col gap-8 border p-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-13 truncate font-mono">{npub}</span>
          <span className="text-12 text-text-3">{[...roles, ...uses].join(', ')}</span>
        </div>
        {revocable && !confirming ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone={uses.length > 0 ? 'error' : 'warn'}>
            {uses.length > 0
              ? `This key is ${uses.join(' and ')}. Once revoked, the assistant stops showing what it published until you authorize another key and point your settings at it.`
              : 'Once revoked, this key can no longer publish products or policies for your store.'}
          </Notice>
          <div className="flex gap-8">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void onRevoke();
              }}
            >
              Revoke this key
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
