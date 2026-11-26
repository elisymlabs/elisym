import type { EventTemplate } from 'nostr-tools';
import { useRef, useState } from 'react';
import { OwnTabNotice } from '../components/OwnTabNotice';
import { NotAvailable } from './components/NotAvailable';
import { Session } from './components/Session';
import { SignIn } from './components/SignIn';
import type { HostedConfigRead } from './lib/hosted-config';
import type { Signer } from './lib/signer';
import type { StoreApi } from './lib/store-session';
import { clearTabSignedIn, markTabSignedIn } from './lib/tab-session';

interface Props {
  /** Not framed and not opened by another page: only then is the key asked for. */
  ownTab: boolean;
  /** The committed config, read: hosted mode runs only when it is set and valid. */
  config: HostedConfigRead;
  createApi: (signer: Signer, apiBase: string) => StoreApi;
  /** Leaves the page for a new document, so nothing of the key stays reachable. */
  leave: () => void;
}

interface Signed {
  owner: string;
  api: StoreApi;
}

/**
 * Hosted mode. The owner key lives only inside the signer, held in a ref:
 * never in React state, never sent; sign out zeroes it.
 */
export function HostedApp({ ownTab, config, createApi, leave }: Props) {
  const signer = useRef<Signer | undefined>(undefined);
  const [signed, setSigned] = useState<Signed | undefined>(undefined);

  if (!ownTab) {
    return <OwnTabNotice keyName="owner key" />;
  }
  if (config.kind !== 'configured') {
    return <NotAvailable />;
  }

  const onSigner = (next: Signer) => {
    if (signer.current !== undefined) {
      next.close();
      return;
    }
    signer.current = next;
    markTabSignedIn(next.pubkey);
    setSigned({ owner: next.pubkey, api: createApi(next, config.config.apiBase) });
  };

  const signOut = () => {
    signer.current?.close();
    signer.current = undefined;
    clearTabSignedIn();
    setSigned(undefined);
    leave();
  };

  const signEvent = (template: EventTemplate) => {
    const current = signer.current;
    if (current === undefined) {
      return Promise.reject(new Error('signed out'));
    }
    return current.signEvent(template);
  };

  if (signed === undefined) {
    return <SignIn onSigner={onSigner} />;
  }
  return (
    <Session
      api={signed.api}
      config={config.config}
      owner={signed.owner}
      signEvent={signEvent}
      onSignOut={signOut}
    />
  );
}
