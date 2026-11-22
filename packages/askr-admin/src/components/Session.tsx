import type { StoreConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SYNC_POLL_MS } from '../constants';
import { ApiError } from '../lib/api';
import { ACTIVE_ONBOARDING_TEXT } from '../lib/billing';
import { CatalogQueue } from '../lib/catalog-writer';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import type { PlanIntent } from '../lib/plan-intent';
import { npubOf } from '../lib/signer';
import { readCatalog, readConfig } from '../lib/store-data';
import { ownSignedEvents, withStoredEvents } from '../lib/stored-events';
import type { StoreStatus, StoreView } from '../lib/types';
import { BillingReturnNotice } from './BillingReturnNotice';
import { FinishMove } from './FinishMove';
import { MovedAway } from './MovedAway';
import { Notice } from './Notice';
import { Onboarding } from './Onboarding';
import type { PlanStep } from './PlanSteps';
import { Shell } from './Shell';

interface Props {
  deps: SessionDeps;
  onSignOut: () => void;
  /** Sign out and replace the secret key of this store (Store ID), K21. */
  onReplaceKey: (storeId: string) => void;
  /** The paid plan chosen on the landing, until its checkout or portal opens or it is dismissed. */
  intent?: PlanIntent;
  onIntentDone?: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'missing' }
  /** This key is one the store moved away from (K21). */
  | { state: 'moved' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; view: StoreView };

/**
 * A signed-in owner: their store from the API and its config from the relay,
 * or, while the store is not active or its signed events are still being
 * published, from what O signed and the server holds for the relay (7.3).
 */
export function Session({
  deps,
  onSignOut,
  onReplaceKey,
  intent,
  onIntentDone = () => undefined,
}: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // Read once the owner is signed in (never by a key recovery on the sign-in page), so the
  // return is said wherever the session lands: Onboarding too, for a store paid before its
  // settings (D5).
  const [billingReturn] = useState(() => deps.takeBillingReturn());
  const [config, setConfig] = useState<StoreConfig>();
  const [configError, setConfigError] = useState('');
  const [configRead, setConfigRead] = useState(false);
  /** The date of a newest config that does not parse: a new one must be dated after it. */
  const [unreadableAt, setUnreadableAt] = useState<number>();
  const [reloadWarning, setReloadWarning] = useState('');
  /**
   * The owner's stored events in use: none once the store is active and nothing is waiting (the
   * relay is the source).
   */
  const [stored, setStored] = useState<NostrEvent[]>([]);
  /** The server left older stored events out of its answer for size. */
  const [storedTruncated, setStoredTruncated] = useState(false);
  /** The config shown is one of the stored events, not the relay's. */
  const [configFromServer, setConfigFromServer] = useState(false);
  /** The store's state as last read, for the config read that follows. */
  const status = useRef<StoreStatus | undefined>(undefined);
  /** Its signed events not published yet, as last read: an activation publishes them a moment later. */
  const pending = useRef(0);

  /** Read the store again: true once it was read. */
  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const view = await deps.api.store();
      status.current = view.status;
      pending.current = view.events.pending;
      setLoad({ state: 'ready', view });
      setReloadWarning('');
      return true;
    } catch (error) {
      const missing = error instanceof ApiError && error.code === 'no_store';
      const moved = error instanceof ApiError && error.code === 'moved';
      // Only the first load may fail the page: later, the last view stays with a warning, so a
      // failed poll or a reload after an action never wipes the dashboard or unsaved edits.
      setLoad((previous) => {
        if (previous.state === 'ready') {
          return previous;
        }
        if (moved) {
          return { state: 'moved' };
        }
        return missing ? { state: 'missing' } : { state: 'failed', error: errorMessage(error) };
      });
      setReloadWarning(`The store could not be refreshed: ${errorMessage(error)}`);
      return false;
    }
  }, [deps]);

  /** Read the settings again: true once they were read (readable or not). */
  const reloadConfig = useCallback(async (): Promise<boolean> => {
    let own: NostrEvent[] = [];
    let truncated = false;
    const active = status.current === 'active';
    // Right after an activation the relay may not have the settings yet: until the stored events
    // are published, what O signed is read back for an active store too.
    if (status.current !== undefined && (!active || pending.current > 0)) {
      try {
        const read = await deps.api.storedEvents();
        own = ownSignedEvents(read.events, deps.signer.pubkey);
        truncated = read.truncated;
      } catch (error) {
        // An active store's settings are on the relay too (or soon): it falls back to the relay.
        if (!active) {
          setConfigError(`Your saved settings could not be read: ${errorMessage(error)}`);
          setConfigRead(true);
          return false;
        }
      }
    }
    setStored(own);
    setStoredTruncated(truncated);
    try {
      const reader = withStoredEvents(deps.reader, own);
      const read = await readConfig(reader, deps.signer.pubkey, deps.now());
      let shownId: string | undefined;
      if (read.state === 'unreadable') {
        setConfig(read.fallback);
        setUnreadableAt(read.newestAt);
        shownId = read.fallbackId;
      } else {
        setConfig(read.state === 'ok' ? read.config : undefined);
        setUnreadableAt(undefined);
        shownId = read.state === 'ok' ? read.id : undefined;
      }
      setConfigFromServer(own.some((event) => event.id === shownId));
      setConfigError('');
      return true;
    } catch {
      setConfigError(
        'Your published settings could not be read, so they are not shown. Retry in a moment.',
      );
      return false;
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

  /** The view as last rendered, for the catalog queue's fresh reads. */
  const viewNow = useRef<StoreView | undefined>(undefined);
  if (load.state === 'ready') {
    viewNow.current = load.view;
  }
  // The session's catalog writes, created and disposed in the same effect (so StrictMode's dev
  // remount leaves a live one), keyed on the session only: polls and reloads keep its entries.
  const [catalogQueue, setCatalogQueue] = useState<CatalogQueue>();
  useEffect(() => {
    const queue = new CatalogQueue({
      api: deps.api,
      reload,
      readProducts: () => {
        const key = viewNow.current?.catalogKey;
        if (key === undefined) {
          return Promise.reject(new Error('The store is not read yet. Retry in a moment.'));
        }
        return readCatalog(deps.reader, key, deps.now());
      },
    });
    setCatalogQueue(queue);
    return () => queue.dispose();
  }, [deps, reload]);

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
    const timer = setInterval(() => void reload(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncRunning, reload, deps]);

  if (load.state === 'moved') {
    return (
      <MovedAway
        onTakeBack={() => onReplaceKey(npubOf(deps.signer.pubkey))}
        onSignOut={onSignOut}
        store={deps.signer.pubkey}
      />
    );
  }
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
  // A store moved to this key (K21) whose settings this key has not signed yet.
  if (needsSetup && view !== undefined && view.movedFrom !== null) {
    return <FinishMove deps={deps} view={view} onDone={reloadAll} onSignOut={onSignOut} />;
  }
  const billingNotice =
    billingReturn === undefined || view === undefined ? null : (
      <BillingReturnNotice
        flag={billingReturn}
        view={view}
        refresh={reloadAll}
        {...(needsSetup ? { activeText: ACTIVE_ONBOARDING_TEXT } : {})}
      />
    );
  const intentProps = intent === undefined ? { onIntentDone } : { intent, onIntentDone };
  if (needsSetup) {
    // Just paid: the settings are left. A plan chosen and not paid yet: paying is next.
    let step: PlanStep | undefined;
    if (billingReturn === 'success') {
      step = 3;
    } else if (intent !== undefined) {
      step = 2;
    }
    return (
      <Onboarding
        deps={deps}
        view={view}
        onCreated={(created) => setLoad({ state: 'ready', view: created })}
        onDone={reloadAll}
        onSignOut={onSignOut}
        billingNotice={billingNotice}
        {...(step === undefined ? {} : { step })}
        {...intentProps}
      />
    );
  }
  return (
    <Shell
      deps={shellDeps}
      view={view}
      config={config}
      configFromServer={configFromServer}
      storedTruncated={storedTruncated}
      configError={configError}
      configUnreadableAt={unreadableAt}
      reloadWarning={reloadWarning}
      reload={reload}
      reloadConfig={reloadConfig}
      {...(catalogQueue === undefined ? {} : { catalogQueue })}
      onSignOut={onSignOut}
      onReplaceKey={() => onReplaceKey(npubOf(view.owner))}
      billingNotice={billingNotice}
      {...(billingReturn === undefined ? {} : { billingReturn })}
      {...intentProps}
    />
  );
}
