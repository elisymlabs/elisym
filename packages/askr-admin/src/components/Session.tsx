import type { StoreConfig } from '@elisym/askr';
import { useCallback, useEffect, useState } from 'react';
import { SYNC_POLL_MS } from '../constants';
import { ApiError } from '../lib/api';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { readConfig } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Onboarding } from './Onboarding';
import { Shell } from './Shell';

interface Props {
  deps: SessionDeps;
  onSignOut: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; view: StoreView };

/** A signed-in owner: their store from the API and its config from the relay. */
export function Session({ deps, onSignOut }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [config, setConfig] = useState<StoreConfig>();
  const [configError, setConfigError] = useState('');
  const [configRead, setConfigRead] = useState(false);

  const reload = useCallback(async () => {
    try {
      setLoad({ state: 'ready', view: await deps.api.store() });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_store') {
        setLoad({ state: 'missing' });
        return;
      }
      setLoad({ state: 'failed', error: errorMessage(error) });
    }
  }, [deps]);

  const reloadConfig = useCallback(async () => {
    try {
      setConfig(await readConfig(deps.reader, deps.signer.pubkey));
      setConfigError('');
    } catch {
      setConfigError('The relay could not be read, so the published settings are not shown.');
    } finally {
      setConfigRead(true);
    }
  }, [deps]);

  useEffect(() => {
    void reload();
    void reloadConfig();
  }, [reload, reloadConfig]);

  const syncRunning = load.state === 'ready' && load.view.catalogSync?.state === 'running';
  useEffect(() => {
    if (!syncRunning) {
      return undefined;
    }
    const timer = setInterval(() => void reload(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncRunning, reload]);

  if (load.state === 'loading' || (load.state === 'ready' && !configRead)) {
    return <p className="text-14 text-text-2 p-24">Loading your store...</p>;
  }
  if (load.state === 'failed') {
    return (
      <main className="mx-auto flex max-w-560 flex-col gap-12 p-24">
        <Notice tone="error">{load.error}</Notice>
        <div className="flex gap-8">
          <button type="button" className="btn" onClick={() => void reload()}>
            Retry
          </button>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }
  // Nothing signed yet: no config on the relay and none waiting on the server.
  const view = load.state === 'ready' ? load.view : undefined;
  const needsSetup =
    view === undefined || (config === undefined && configError === '' && view.events.pending === 0);
  if (needsSetup) {
    return (
      <Onboarding
        deps={deps}
        view={view}
        onCreated={(created) => setLoad({ state: 'ready', view: created })}
        onDone={async () => {
          await reload();
          await reloadConfig();
        }}
        onSignOut={onSignOut}
      />
    );
  }
  return (
    <Shell
      deps={deps}
      view={view}
      config={config}
      configError={configError}
      reload={reload}
      reloadConfig={reloadConfig}
      onSignOut={onSignOut}
    />
  );
}
