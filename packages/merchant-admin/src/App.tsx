import { useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { OwnTabNotice } from './components/OwnTabNotice';
import { SignIn } from './components/SignIn';
import {
  AdminSession,
  type Outcome,
  type SessionDeps,
  type Snapshot,
  type StoreKey,
  type StoreView,
} from './lib/core';

interface Props {
  /** Not framed and not opened by another page: only then is the key asked for. */
  ownTab: boolean;
  createDeps: () => SessionDeps;
  /** Leaves the page for a new document, so nothing of the key stays reachable. */
  leave: () => void;
}

export interface DashboardState {
  pubkey: string;
  store?: StoreView;
  snapshot?: Snapshot;
  status: string;
  busy: boolean;
}

/**
 * The admin. The key lives only inside the session, held in a ref: never in
 * React state, never stored, never sent (it signs the relays' AUTH only).
 */
export function App({ ownTab, createDeps, leave }: Props) {
  const session = useRef<AdminSession | undefined>(undefined);
  const [state, setState] = useState<DashboardState | undefined>(undefined);

  const run = async (task: (current: AdminSession) => Promise<Outcome>) => {
    const current = session.current;
    if (current === undefined) {
      return;
    }
    setState((previous) => previous && { ...previous, busy: true });
    const outcome = await task(current);
    if (outcome === 'busy') {
      // Another run holds the buttons.
      return;
    }
    setState(
      (previous) =>
        previous && {
          ...previous,
          busy: false,
          ...(outcome.ok ? { snapshot: outcome.snapshot } : {}),
        },
    );
  };

  const open = (key: StoreKey) => {
    if (session.current !== undefined) {
      return;
    }
    session.current = new AdminSession(
      createDeps(),
      key,
      { readAllListings: true },
      (status) => setState((previous) => previous && { ...previous, status }),
      (store) => setState((previous) => previous && { ...previous, store }),
    );
    setState({ pubkey: key.pubkey, status: '', busy: true });
    void run((current) => current.open());
  };

  const logOut = () => {
    session.current?.close();
    session.current = undefined;
    leave();
  };

  if (!ownTab) {
    return <OwnTabNotice />;
  }
  if (state === undefined) {
    return <SignIn onKey={open} />;
  }
  return (
    <Dashboard
      state={state}
      onRefresh={() => void run((current) => current.refresh())}
      onMore={() => void run((current) => current.more())}
      onLogOut={logOut}
    />
  );
}
