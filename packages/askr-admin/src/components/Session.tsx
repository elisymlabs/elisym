import type { StoreConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { type SessionDeps, syncPollMs } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { readConfig } from '../lib/store-data';
import { ownSignedEvents, withStoredEvents } from '../lib/stored-events';
import type { StoreStatus, StoreView } from '../lib/types';
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

/**
 * A signed-in owner: their store from the API and its config from the relay,
 * or, while the store is not active, from what O signed and the server holds
 * for the relay (7.3).
 */
export function Session({ deps, onSignOut }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [config, setConfig] = useState<StoreConfig>();
  const [configError, setConfigError] = useState('');
  const [configRead, setConfigRead] = useState(false);
  /** The date of a newest config that does not parse: a new one must be dated after it. */
  const [unreadableAt, setUnreadableAt] = useState<number>();
  const [reloadWarning, setReloadWarning] = useState('');
  /** The owner's stored events in use: none once the store is active (the relay is the source). */
  const [stored, setStored] = useState<NostrEvent[]>([]);
  /** The store's state as last read, for the config read that follows. */
  const status = useRef<StoreStatus | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const view = await deps.api.store();
      status.current = view.status;
      setLoad({ state: 'ready', view });
      setReloadWarning('');
    } catch (error) {
      const missing = error instanceof ApiError && error.code === 'no_store';
      // Only the first load may fail the page: later, the last view stays with a warning, so a
      // failed poll or a reload after an action never wipes the dashboard or unsaved edits.
      setLoad((previous) => {
        if (previous.state === 'ready') {
          return previous;
        }
        return missing ? { state: 'missing' } : { state: 'failed', error: errorMessage(error) };
      });
      setReloadWarning(`The store could not be refreshed: ${errorMessage(error)}`);
    }
  }, [deps]);

  const reloadConfig = useCallback(async () => {
    let own: NostrEvent[] = [];
    if (status.current !== undefined && status.current !== 'active') {
      try {
        own = ownSignedEvents((await deps.api.storedEvents()).events, deps.signer.pubkey);
      } catch (error) {
        setConfigError(`Your saved settings could not be read: ${errorMessage(error)}`);
        setConfigRead(true);
        return;
      }
    }
    setStored(own);
    try {
      const reader = withStoredEvents(deps.reader, own);
      const read = await readConfig(reader, deps.signer.pubkey, deps.now());
      if (read.state === 'unreadable') {
        setConfig(read.fallback);
        setUnreadableAt(read.newestAt);
      } else {
        setConfig(read.state === 'ok' ? read.config : undefined);
        setUnreadableAt(undefined);
      }
      setConfigError('');
    } catch {
      setConfigError('The relay could not be read, so the published settings are not shown.');
    } finally {
      setConfigRead(true);
    }
  }, [deps]);

  // The store first: its state decides where the config is read from.
  const reloadAll = useCallback(async () => {
    await reload();
    await reloadConfig();
  }, [reload, reloadConfig]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  // The sections read authorizations through the same reader as the config.
  const shellDeps = useMemo(
    () => (stored.length === 0 ? deps : { ...deps, reader: withStoredEvents(deps.reader, stored) }),
    [deps, stored],
  );

  const syncRunning = load.state === 'ready' && load.view.catalogSync?.state === 'running';
  useEffect(() => {
    if (!syncRunning) {
      return undefined;
    }
    const timer = setInterval(() => void reload(), syncPollMs(deps.signer));
    return () => clearInterval(timer);
  }, [syncRunning, reload, deps]);

  if (load.state === 'loading' || (load.state === 'ready' && !configRead)) {
    return <p className="text-14 text-text-2 p-24">Loading your store...</p>;
  }
  if (load.state === 'failed') {
    return (
      <main className="mx-auto flex max-w-560 flex-col gap-12 p-24">
        <Notice tone="error">{load.error}</Notice>
        <div className="flex gap-8">
          <button type="button" className="btn" onClick={() => void reloadAll()}>
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
    view === undefined ||
    (config === undefined &&
      configError === '' &&
      unreadableAt === undefined &&
      view.events.pending === 0);
  if (needsSetup) {
    return (
      <Onboarding
        deps={deps}
        view={view}
        onCreated={(created) => setLoad({ state: 'ready', view: created })}
        onDone={reloadAll}
        onSignOut={onSignOut}
      />
    );
  }
  return (
    <Shell
      deps={shellDeps}
      view={view}
      config={config}
      configFromServer={stored.length > 0}
      configError={configError}
      configUnreadableAt={unreadableAt}
      reloadWarning={reloadWarning}
      reload={reload}
      reloadConfig={reloadConfig}
      onSignOut={onSignOut}
    />
  );
}
