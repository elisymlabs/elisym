import { useCallback, useEffect, useRef, useState } from 'react';
import { CreateFlow } from './components/CreateFlow';
import { Home } from './components/Home';
import { type ConsoleApi, type Fetcher, createConsoleApi } from './lib/api';
import type { RelayQuery } from './lib/key-in-use';
import { OwnerKey, ownerKeyFile, ownerKeyFileName } from './lib/owner-key';
import type { CheckoutReturn } from './lib/start';
import { fetchTiers } from './lib/tiers';

/** The cloud part's configuration and tools, as the page gives them. */
export interface CloudProps {
  /** cloud-api's origin, the one the CSP allows. */
  apiOrigin: string;
  /** Hands the merchant a file to save. */
  download: (data: string | Uint8Array<ArrayBuffer>, fileName: string) => void;
  /** Reads the owner's events from the relays (the "one nsec per store" warning). */
  relayQuery: RelayQuery;
  /** The plan a `/start` link chose, if the console was opened from one. */
  startTier: string | undefined;
  /** Where the terms of service and acceptable-use policy are read. */
  termsUrl: string | undefined;
  /** The Pay Core billing page, if the cloud has one. */
  billingUrl: string | undefined;
  /** A top-level navigation (to Stripe's Checkout or Portal). */
  navigate: (url: string) => void;
  /** How a Stripe Checkout came back, when the console was opened from it. */
  checkoutReturn?: CheckoutReturn;
  /** The local clock, in seconds (a test's own). */
  localNow?: () => number;
  /** How requests reach cloud-api (the browser's fetch, or a test's in-process API). */
  fetcher?: Fetcher;
  /** How long the sign-in waits on cloud-api (a test's own; the admin's is `CLOUD_PROBE_MS`). */
  probeMs?: number;
}

interface Props extends CloudProps {
  /** Leaves the page for a new document, so nothing of the key stays reachable. */
  leave: () => void;
  /** Back to the admin's front door, from the create flow (a key made there is closed first). */
  onBack?: () => void;
  /** To the admin's one sign-in field, for a key saved before, with the plan picked so far. */
  onSignIn: (tier: string | undefined) => void;
  /** An owner key the admin's sign-in already took and routed here: no key step. */
  initialKey?: OwnerKey;
  /** What the sign-in found, said on the store page. */
  notice?: string;
}

type Stage =
  /** Creating a store (plan, access key, terms); `made` once the key exists. */
  | { name: 'create'; made: { npub: string } | undefined }
  | { name: 'signed-in'; npub: string; pubkey: string };

/**
 * The cloud part of the admin (the store's own tab is checked before it). The owner key lives only inside an `OwnerKey` held in a ref:
 * never in React state, never stored, never sent (it signs auth and owner
 * events in the page).
 */
export function CloudApp({
  apiOrigin,
  download,
  leave,
  relayQuery,
  startTier,
  termsUrl,
  billingUrl,
  navigate,
  checkoutReturn,
  localNow = () => Math.floor(Date.now() / 1000),
  fetcher,
  onBack,
  onSignIn,
  initialKey,
  notice,
}: Props) {
  const owner = useRef<OwnerKey | undefined>(initialKey);
  const api = useRef<ConsoleApi | undefined>(
    initialKey === undefined
      ? undefined
      : createConsoleApi({
          apiOrigin,
          signer: initialKey,
          localNow,
          ...(fetcher === undefined ? {} : { fetcher }),
        }),
  );
  const [stage, setStage] = useState<Stage>(
    initialKey === undefined
      ? { name: 'create', made: undefined }
      : { name: 'signed-in', npub: initialKey.npub, pubkey: initialKey.pubkey },
  );

  // Leaving the page zeroes the key; a page brought back from the back/forward cache starts over.
  useEffect(() => {
    const close = () => owner.current?.close();
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        leave();
      }
    };
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', restored);
    };
  }, [leave]);

  // Stable: the plan picker reads the catalog again only when it changes.
  const loadTiers = useCallback(() => fetchTiers(apiOrigin, fetcher), [apiOrigin, fetcher]);

  const hold = (key: OwnerKey) => {
    owner.current?.close();
    owner.current = key;
    api.current = createConsoleApi({
      apiOrigin,
      signer: key,
      localNow,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  };

  // The made key's store exists now: the console reads it (stable: the create flow's read waits on it).
  const opened = useCallback(() => {
    const key = owner.current;
    if (key !== undefined) {
      setStage({ name: 'signed-in', npub: key.npub, pubkey: key.pubkey });
    }
  }, []);

  // One access key per visit: once made, the create flow never makes another.
  const create = () => {
    if (owner.current !== undefined) {
      return;
    }
    const key = OwnerKey.create();
    hold(key);
    setStage({ name: 'create', made: { npub: key.npub } });
  };

  // Leaving the create flow (for the sign-in, or back to the front door) closes a key made there:
  // here, on the way out, never in an effect cleanup (StrictMode runs those on a live key).
  const leaveFlow = (next: () => void) => {
    owner.current?.close();
    owner.current = undefined;
    api.current = undefined;
    next();
  };

  const save = () => {
    const key = owner.current;
    if (key !== undefined) {
      download(ownerKeyFile(key), ownerKeyFileName(key));
    }
  };

  const signOut = () => {
    owner.current?.close();
    owner.current = undefined;
    api.current = undefined;
    leave();
  };

  const signedIn = api.current;
  const signer = owner.current;
  if (stage.name === 'create' || signedIn === undefined || signer === undefined) {
    return (
      <CreateFlow
        loadTiers={loadTiers}
        preselect={startTier}
        made={stage.name === 'create' ? stage.made : undefined}
        api={api.current}
        termsUrl={termsUrl}
        onCreateKey={create}
        onSaveKey={save}
        onStore={opened}
        onSignIn={(tier) => leaveFlow(() => onSignIn(tier))}
        onBack={onBack === undefined ? undefined : () => leaveFlow(onBack)}
      />
    );
  }
  return (
    <Home
      npub={stage.npub}
      pubkey={stage.pubkey}
      api={signedIn}
      loadTiers={loadTiers}
      relayQuery={relayQuery}
      startTier={startTier}
      termsUrl={termsUrl}
      billingUrl={billingUrl}
      navigate={navigate}
      checkoutReturn={checkoutReturn}
      tools={{
        signer,
        relayQuery,
        // The cloud's domain: the host its API answers on.
        operator: new URL(apiOrigin).hostname,
        localNow,
        download,
      }}
      onSignOut={signOut}
      {...(notice === undefined ? {} : { notice })}
    />
  );
}
