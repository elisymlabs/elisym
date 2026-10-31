import { useEffect, useRef, useState } from 'react';
import { App } from './App';
import { CloudApp, type CloudProps } from './cloud/CloudApp';
import { createConsoleApi } from './cloud/lib/api';
import type { OwnerKey } from './cloud/lib/owner-key';
import { type Routed, dropRouted, routeKey } from './cloud/lib/route-key';
import { EntryPage } from './components/EntryPage';
import { OwnTabNotice } from './components/OwnTabNotice';
import { SignIn } from './components/SignIn';
import { type SessionDeps, type StoreKey, readStore } from './lib/core';
import { relaysShowAStore } from './lib/key-route';

interface Props {
  /** Not framed and not opened by another page: only then is a key asked for. */
  ownTab: boolean;
  /** The self-hosted session's reads (the relays). */
  createDeps: () => SessionDeps;
  /** Leaves the page for a new document, so nothing of a key stays reachable. */
  leave: () => void;
  /** The cloud part, when this build has a cloud-api origin; none: self-hosted only. */
  cloud: CloudProps | undefined;
}

/** How long the sign-in waits on cloud-api, its one retry included, before the relays decide alone. */
export const CLOUD_PROBE_MS = 5000;

export const NOTHING_ON_RELAYS =
  'For a store you run yourself, the relays showed nothing for this key: check the key, or sign out and try again.';
export const NOT_ANSWERING =
  'Our cloud is not answering, and the relays showed nothing for this key: try again.';

type Mode =
  | { name: 'entry' }
  | { name: 'sign-in' }
  | { name: 'create' }
  | { name: 'cloud'; notice: string | undefined }
  | { name: 'self-hosted' };

/** A key routed to a part, held until that part has taken it. */
interface Held {
  store?: StoreKey;
  owner?: OwnerKey;
}

/**
 * The admin's one entry: make a store in our cloud, or sign in with one key
 * field, which opens a store in our cloud, a partner's account, or a store
 * the merchant runs (plan `admin-unified.md` 2.3). A `/start` link opens the
 * create flow; a card payment's return opens the sign-in (its store exists). The pasted key is held in
 * a ref only while it is routed and handed over: then by the part that opened
 * it, or zeroed. Leaving the sign-in drops a route still under way.
 */
export function Root({ ownTab, createDeps, leave, cloud }: Props) {
  // A card payment's return signs in (its store exists: no second key); a `/start` link creates.
  const firstMode = (): Mode => {
    if (cloud?.checkoutReturn !== undefined) {
      return { name: 'sign-in' };
    }
    return cloud?.startTier === undefined ? { name: 'entry' } : { name: 'create' };
  };
  const [mode, setMode] = useState<Mode>(firstMode);
  const [cameBack, setCameBack] = useState(cloud?.checkoutReturn !== undefined);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');
  const held = useRef<Held>({});
  // Bumped by every way out of the sign-in: a route that started before it counts for nothing.
  const attempt = useRef(0);
  // A plan picked in the create flow before going to the sign-in: kept for the store part it opens.
  const tier = useRef<string | undefined>(undefined);

  // The part opened has taken its key (its effects run before this one): Root lets go of it.
  useEffect(() => {
    if (mode.name === 'cloud' || mode.name === 'self-hosted') {
      held.current = {};
    }
  }, [mode]);

  const go = (next: Mode) => {
    attempt.current += 1;
    setChecking(false);
    setProblem('');
    setCameBack(false);
    if (next.name === 'entry') {
      tier.current = undefined;
    }
    setMode(next);
  };

  const routeWith = async (key: StoreKey, apiOrigin: string): Promise<Routed> => {
    const deps = createDeps();
    try {
      return await routeKey(key, {
        askOwner: (owner) =>
          createConsoleApi({
            apiOrigin,
            signer: owner,
            timeoutMs: cloud?.probeMs ?? CLOUD_PROBE_MS,
            ...(cloud?.localNow === undefined ? {} : { localNow: cloud.localNow }),
            ...(cloud?.fetcher === undefined ? {} : { fetcher: cloud.fetcher }),
          }).request('GET', '/owner'),
        relaysShowAStore: async (pubkey) =>
          relaysShowAStore(await readStore(deps.client, pubkey, deps.now())),
      });
    } finally {
      deps.client.close();
    }
  };

  const route = async (key: StoreKey, apiOrigin: string) => {
    // A second key while one is routed: the first one's route counts for nothing.
    attempt.current += 1;
    const mine = attempt.current;
    setChecking(true);
    setProblem('');
    let routed: Routed;
    try {
      routed = await routeWith(key, apiOrigin);
    } catch {
      // Nothing routed it: no copy of it is kept, and the field is free again.
      key.secretKey.fill(0);
      if (mine === attempt.current) {
        setChecking(false);
        setProblem(NOT_ANSWERING);
      }
      return;
    }
    if (mine !== attempt.current) {
      dropRouted(routed);
      return;
    }
    setChecking(false);
    if (routed.where === 'self-hosted') {
      // A store run by the merchant takes no plan.
      tier.current = undefined;
      held.current = { store: routed.key };
      setMode({ name: 'self-hosted' });
    } else if (routed.where === 'unreachable') {
      setProblem(NOT_ANSWERING);
    } else {
      held.current = { owner: routed.owner };
      setMode({
        name: 'cloud',
        notice: routed.where === 'cloud-none' ? NOTHING_ON_RELAYS : undefined,
      });
    }
  };

  if (!ownTab) {
    return <OwnTabNotice />;
  }
  if (cloud === undefined || mode.name === 'self-hosted') {
    return (
      <App
        ownTab={ownTab}
        createDeps={createDeps}
        leave={leave}
        {...(held.current.store === undefined ? {} : { initialKey: held.current.store })}
      />
    );
  }
  if (mode.name === 'create') {
    return (
      <CloudApp
        {...cloud}
        leave={leave}
        onBack={() => go({ name: 'entry' })}
        onSignIn={(picked) => {
          go({ name: 'sign-in' });
          tier.current = picked;
        }}
      />
    );
  }
  if (mode.name === 'cloud') {
    return (
      <CloudApp
        {...cloud}
        leave={leave}
        startTier={tier.current ?? cloud.startTier}
        onSignIn={() => go({ name: 'sign-in' })}
        {...(held.current.owner === undefined ? {} : { initialKey: held.current.owner })}
        notice={mode.notice}
      />
    );
  }
  if (mode.name === 'sign-in') {
    return (
      <SignIn
        onKey={(key) => void route(key, cloud.apiOrigin)}
        cloud={{
          checking,
          problem,
          onBack: () => go({ name: 'entry' }),
          ...(cameBack
            ? {
                line: 'Your card payment came back: sign in with your access key to see your store.',
              }
            : {}),
        }}
      />
    );
  }
  return (
    <EntryPage onCreate={() => go({ name: 'create' })} onSignIn={() => go({ name: 'sign-in' })} />
  );
}
