import { useEffect, useRef, useState } from 'react';
import { Home } from './components/Home';
import { KeyStep } from './components/KeyStep';
import { SaveKey } from './components/SaveKey';
import { type ConsoleApi, type Fetcher, createConsoleApi } from './lib/api';
import type { RelayQuery } from './lib/key-in-use';
import { OwnerKey, ownerKeyFile, ownerKeyFileName } from './lib/owner-key';
import type { CheckoutReturn } from './lib/start';
import type { WalletProviders } from './lib/wallet';

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
  /** The page's wallet extensions (a payout's proof). */
  wallets?: WalletProviders;
  /** The local clock, in seconds (a test's own). */
  localNow?: () => number;
  /** How requests reach cloud-api (the browser's fetch, or a test's in-process API). */
  fetcher?: Fetcher;
}

interface Props extends CloudProps {
  /** Leaves the page for a new document, so nothing of the key stays reachable. */
  leave: () => void;
  /** Back to the admin's front door, before a key is held. */
  onBack?: () => void;
}

type Stage =
  | { name: 'key' }
  | { name: 'save'; npub: string; pubkey: string }
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
  wallets = { solana: undefined, evm: undefined },
  localNow = () => Math.floor(Date.now() / 1000),
  fetcher,
  onBack,
}: Props) {
  const owner = useRef<OwnerKey | undefined>(undefined);
  const api = useRef<ConsoleApi | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ name: 'key' });

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

  const create = () => {
    const key = OwnerKey.create();
    hold(key);
    setStage({ name: 'save', npub: key.npub, pubkey: key.pubkey });
  };

  const signIn = (key: OwnerKey) => {
    hold(key);
    setStage({ name: 'signed-in', npub: key.npub, pubkey: key.pubkey });
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

  if (stage.name === 'key') {
    return <KeyStep onCreate={create} onKey={signIn} onBack={onBack} />;
  }
  if (stage.name === 'save') {
    return (
      <SaveKey
        npub={stage.npub}
        onSave={save}
        onContinue={() => setStage({ name: 'signed-in', npub: stage.npub, pubkey: stage.pubkey })}
      />
    );
  }
  const signedIn = api.current;
  const signer = owner.current;
  if (signedIn === undefined || signer === undefined) {
    return <KeyStep onCreate={create} onKey={signIn} onBack={onBack} />;
  }
  return (
    <Home
      npub={stage.npub}
      pubkey={stage.pubkey}
      api={signedIn}
      relayQuery={relayQuery}
      startTier={startTier}
      termsUrl={termsUrl}
      billingUrl={billingUrl}
      navigate={navigate}
      checkoutReturn={checkoutReturn}
      tools={{
        signer,
        relayQuery,
        wallets,
        // The cloud's domain: the host its API answers on.
        operator: new URL(apiOrigin).hostname,
        localNow,
        download,
      }}
      onSignOut={signOut}
    />
  );
}
