import { useState } from 'react';
import { App } from './App';
import { CloudApp, type CloudProps } from './cloud/CloudApp';
import { EntryPage } from './components/EntryPage';
import { OwnTabNotice } from './components/OwnTabNotice';
import type { SessionDeps } from './lib/core';

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

type Mode = 'entry' | 'cloud' | 'self-hosted';

/**
 * The admin's one entry: make a store in our cloud or sign in to one, or open
 * a store you run yourself. A `/start` link or a card payment's return goes
 * straight to the cloud part.
 */
export function Root({ ownTab, createDeps, leave, cloud }: Props) {
  const opensCloud =
    cloud !== undefined && (cloud.startTier !== undefined || cloud.checkoutReturn !== undefined);
  const [mode, setMode] = useState<Mode>(opensCloud ? 'cloud' : 'entry');

  if (!ownTab) {
    return <OwnTabNotice />;
  }
  if (cloud === undefined || mode === 'self-hosted') {
    return <App ownTab={ownTab} createDeps={createDeps} leave={leave} />;
  }
  if (mode === 'cloud') {
    return <CloudApp {...cloud} leave={leave} onBack={() => setMode('entry')} />;
  }
  return (
    <EntryPage
      cloud
      onCreate={() => setMode('cloud')}
      onCloudSignIn={() => setMode('cloud')}
      onSelfHostedSignIn={() => setMode('self-hosted')}
    />
  );
}
