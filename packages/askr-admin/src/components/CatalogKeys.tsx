import {
  type CatalogKeyRole,
  type StoreConfig,
  buildCatalogAuth,
  buildCatalogRevocation,
} from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ASKR_KEY_COMMAND } from '../constants';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { savedMessage } from '../lib/save';
import { npubOf, parsePublicKey } from '../lib/signer';
import { readAuthority } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';
import { TextField } from './TextField';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
}

const ROLE_NAMES: Readonly<Record<CatalogKeyRole, string>> = {
  catalog: 'catalog key',
  paycore: 'Pay Core store key',
};

/** Authorize or revoke catalog keys K with O-signed 30497 events (1.1). */
export function CatalogKeys({ deps, view, config }: Props) {
  const [keys, setKeys] = useState<[string, Set<CatalogKeyRole>][]>();
  const [readError, setReadError] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const ownerNpub = npubOf(deps.signer.pubkey);

  const read = useCallback(async () => {
    try {
      setKeys([...(await readAuthority(deps.reader, deps.signer.pubkey))]);
      setReadError('');
    } catch {
      setReadError('The relay could not be read, so the authorized keys are not shown.');
    }
  }, [deps]);

  useEffect(() => {
    void read();
  }, [read]);

  const submit = async (sign: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await sign();
      setDone(savedMessage(view));
      await read();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const authorize = () =>
    submit(async () => {
      const key = parsePublicKey(pasted);
      if (key === undefined) {
        throw new Error('Paste the catalog key as an npub or 64 hex characters.');
      }
      const mode = key === view.catalogKey ? 'hosted' : 'self-host';
      const event = await deps.signer.signEvent(
        buildCatalogAuth({ key, mode, createdAt: deps.now() }),
      );
      await deps.api.storeEvents([event]);
      setPasted('');
    });

  const revoke = (key: string) =>
    submit(async () => {
      const event = await deps.signer.signEvent(buildCatalogRevocation(key, deps.now()));
      await deps.api.storeEvents([event]);
    });

  const labelsOf = (key: string): string[] => {
    const labels: string[] = [];
    if (key === view.catalogKey) {
      labels.push('the server key of this admin');
    }
    if (key === config?.catalogKey) {
      labels.push('your product source');
    }
    if (key === config?.policyKey) {
      labels.push('your policies');
    }
    return labels;
  };

  let list: ReactNode = null;
  if (keys !== undefined && keys.length === 0) {
    list = <p className="text-14 text-text-2">No key is authorized on the relay yet.</p>;
  } else if (keys !== undefined) {
    list = (
      <ul className="flex flex-col gap-8">
        {keys.map(([key, roles]) => (
          <li
            key={key}
            className="border-line rounded-10 flex flex-wrap items-center justify-between gap-8 border p-12"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-13 truncate font-mono">{npubOf(key)}</span>
              <span className="text-12 text-text-3">
                {[...[...roles].map((role) => ROLE_NAMES[role]), ...labelsOf(key)].join(', ')}
              </span>
            </div>
            {roles.has('catalog') ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void revoke(key)}
              >
                Revoke
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Section
      title="Catalog keys"
      description="A catalog key publishes your products and policies. Authorize your own key to publish from your backend, the SDK or an AI agent, and revoke a key you no longer use."
    >
      {readError === '' ? null : <Notice tone="warn">{readError}</Notice>}
      {list}
      <div className="flex flex-col gap-8">
        <TextField
          id="authorize-key"
          label="Authorize a catalog key"
          value={pasted}
          placeholder="npub1... or 64 hex characters"
          hint={`Print yours with: ${ASKR_KEY_COMMAND} ${ownerNpub}`}
          onChange={setPasted}
        />
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || pasted.trim() === ''}
            onClick={() => void authorize()}
          >
            Sign and authorize
          </button>
        </div>
      </div>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {done === '' ? null : <Notice tone="success">{done}</Notice>}
    </Section>
  );
}
