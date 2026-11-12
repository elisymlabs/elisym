import {
  type CatalogKeyRole,
  type StoreConfig,
  buildCatalogAuth,
  buildCatalogRevocation,
} from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ASKR_KEY_COMMAND } from '../constants';
import { type SessionDeps, postSigned } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { nextAuthDate, savedMessage } from '../lib/save';
import { npubOf, parsePublicKey } from '../lib/signer';
import { type AuthorityRead, readAuthority } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { KeyRow } from './KeyRow';
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
  const [authority, setAuthority] = useState<AuthorityRead>();
  const [readError, setReadError] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const ownerNpub = npubOf(deps.signer.pubkey);

  const read = useCallback(async () => {
    try {
      setAuthority(await readAuthority(deps.reader, deps.signer.pubkey, deps.now()));
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
      const createdAt = nextAuthDate(key, deps.now(), authority?.newestAt, deps.journal);
      const event = await deps.signer.signEvent(buildCatalogAuth({ key, mode, createdAt }));
      await postSigned(deps, [event]);
      setPasted('');
    });

  const revoke = (key: string) =>
    submit(async () => {
      // Dated after the key's newest authorization, which may be dated ahead of now.
      const createdAt = nextAuthDate(key, deps.now(), authority?.newestAt, deps.journal);
      const event = await deps.signer.signEvent(buildCatalogRevocation(key, createdAt));
      await postSigned(deps, [event]);
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

  const keys = authority === undefined ? undefined : [...authority.keys];
  let list: ReactNode = null;
  if (keys !== undefined && keys.length === 0) {
    list = <p className="text-14 text-text-2">No key is authorized on the relay yet.</p>;
  } else if (keys !== undefined) {
    list = (
      <ul className="flex flex-col gap-8">
        {keys.map(([key, roles]) => (
          <KeyRow
            key={key}
            npub={npubOf(key)}
            roles={[...roles].map((role) => ROLE_NAMES[role])}
            uses={labelsOf(key)}
            revocable={roles.has('catalog')}
            busy={busy}
            onRevoke={() => revoke(key)}
          />
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
