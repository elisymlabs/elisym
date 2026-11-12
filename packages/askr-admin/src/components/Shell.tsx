import type { StoreConfig } from '@elisym/askr';
import { useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { npubOf } from '../lib/signer';
import type { TabId } from '../lib/tabs';
import type { StoreView } from '../lib/types';
import { ConnectorSection } from './ConnectorSection';
import { EmbedSection } from './EmbedSection';
import { KeysSection } from './KeysSection';
import { Notice } from './Notice';
import { Overview } from './Overview';
import { PoliciesSection } from './PoliciesSection';
import { ProductsSection } from './ProductsSection';
import { SettingsSection } from './SettingsSection';
import { TabBar } from './TabBar';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  /** The published config, if the relay has one. */
  config: StoreConfig | undefined;
  configError: string;
  reload: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  onSignOut: () => void;
}

export function Shell({ deps, view, config, configError, reload, reloadConfig, onSignOut }: Props) {
  const [tab, setTab] = useState<TabId>('overview');
  const refresh = async () => {
    await reload();
    await reloadConfig();
  };
  let content;
  if (tab === 'overview') {
    content = <Overview view={view} config={config} />;
  } else if (tab === 'settings') {
    content = (
      <SettingsSection
        deps={deps}
        view={view}
        config={config}
        configError={configError}
        onRetry={reloadConfig}
        onSaved={refresh}
      />
    );
  } else if (tab === 'products') {
    content = <ProductsSection deps={deps} view={view} config={config} reload={reload} />;
  } else if (tab === 'policies') {
    content = <PoliciesSection deps={deps} view={view} config={config} />;
  } else if (tab === 'connector') {
    content = <ConnectorSection deps={deps} view={view} config={config} reload={reload} />;
  } else if (tab === 'keys') {
    content = (
      <KeysSection
        deps={deps}
        view={view}
        config={config}
        configError={configError}
        onRetry={reloadConfig}
        onChanged={refresh}
      />
    );
  } else {
    content = <EmbedSection owner={view.owner} config={config} />;
  }
  return (
    <main className="mx-auto flex max-w-960 flex-col gap-16 px-16 py-24">
      <header className="flex flex-wrap items-center justify-between gap-12">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-20 font-semibold">{config?.name ?? 'Your store'}</h1>
          <span className="text-12 text-text-3 truncate font-mono">{npubOf(view.owner)}</span>
        </div>
        <div className="flex gap-8">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <TabBar active={tab} onSelect={setTab} />
      {configError === '' ? null : <Notice tone="warn">{configError}</Notice>}
      {content}
    </main>
  );
}
