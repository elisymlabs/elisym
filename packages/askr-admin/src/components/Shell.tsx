import type { StoreConfig } from '@elisym/askr';
import { useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { npubOf } from '../lib/signer';
import { TABS, type TabId } from '../lib/tabs';
import type { StoreView } from '../lib/types';
import { AskrMark } from './AskrMark';
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
  /** The config is read from what the server holds for the relay (a store that is not active). */
  configFromServer: boolean;
  /** The server left older stored events out of its read-back for size. */
  storedTruncated: boolean;
  configError: string;
  /** Set when the relay's newest config does not parse: its date (`config` is then an older one). */
  configUnreadableAt: number | undefined;
  /** A later refresh failed: the view shown is the last one read. */
  reloadWarning: string;
  reload: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  onSignOut: () => void;
  onReplaceKey: () => void;
}

export function Shell({
  deps,
  view,
  config,
  configFromServer,
  storedTruncated,
  configError,
  configUnreadableAt,
  reloadWarning,
  reload,
  reloadConfig,
  onSignOut,
  onReplaceKey,
}: Props) {
  const [chosen, setTab] = useState<TabId>('overview');
  // The Connector section is for a connector set up in Settings: without one it is left out.
  const tabs = view.connector === null ? TABS.filter((entry) => entry.id !== 'connector') : TABS;
  const tab = tabs.some((entry) => entry.id === chosen) ? chosen : 'overview';
  const refresh = async () => {
    await reload();
    await reloadConfig();
  };
  let content;
  if (tab === 'overview') {
    content = (
      <Overview
        view={view}
        config={config}
        configFromServer={configFromServer}
        catalogReader={{ reader: deps.reader, now: deps.now }}
      />
    );
  } else if (tab === 'settings') {
    content = (
      <SettingsSection
        deps={deps}
        view={view}
        config={config}
        configError={configError}
        configUnreadableAt={configUnreadableAt}
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
        configError={
          configError === '' && configUnreadableAt !== undefined
            ? 'Your newest settings could not be read. Save them again in Settings before rotating.'
            : configError
        }
        onRetry={reloadConfig}
        onChanged={refresh}
        onReplaceKey={onReplaceKey}
      />
    );
  } else {
    content = <EmbedSection api={deps.api} view={view} config={config} />;
  }
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="bg-sidebar border-line flex flex-col gap-16 border-b px-16 py-16 md:sticky md:top-0 md:h-screen md:w-248 md:flex-none md:border-r md:border-b-0 md:px-12 md:py-20">
        <div className="flex items-center gap-10 px-4 md:px-6">
          <AskrMark className="size-24 flex-none [--mark-paper:var(--sidebar)]" />
          <div className="flex min-w-0 flex-col">
            <span id="sidebar-store-name" className="text-14 truncate font-semibold">
              {config?.name ?? 'Your store'}
            </span>
            <span className="text-12 text-text-3 truncate font-mono" title={npubOf(view.owner)}>
              {npubOf(view.owner)}
            </span>
          </div>
        </div>
        <TabBar tabs={tabs} active={tab} onSelect={setTab} />
        <div className="mt-auto hidden flex-col gap-2 md:flex">
          <button
            type="button"
            className="text-13 text-text-2 hover:bg-hover hover:text-text rounded-8 px-10 py-7 text-left transition-colors"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="text-13 text-text-2 hover:bg-hover hover:text-text rounded-8 px-10 py-7 text-left transition-colors"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-28 px-16 py-24 md:px-48 md:py-40">
        <header className="flex flex-wrap items-start justify-between gap-12">
          <div className="flex max-w-640 flex-col gap-4">
            <h1 className="text-24 font-semibold tracking-tight">{current.label}</h1>
            <p className="text-14 text-text-2">{current.description}</p>
          </div>
          <div className="flex gap-8 md:hidden">
            <button type="button" className="btn" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" className="btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </header>
        <div className="flex max-w-760 flex-col gap-32">
          {configError === '' ? null : (
            <Notice tone="warn">
              {configError}{' '}
              <button type="button" className="underline" onClick={() => void reloadConfig()}>
                Retry
              </button>
            </Notice>
          )}
          {reloadWarning === '' ? null : (
            <Notice tone="warn">
              {reloadWarning} What is shown is the last state read.{' '}
              <button type="button" className="underline" onClick={() => void reload()}>
                Retry
              </button>
            </Notice>
          )}
          {storedTruncated ? (
            <Notice tone="warn">
              Some older changes you signed are not shown here: there were too many to read back at
              once. Your current settings are shown; nothing is lost on the server.
            </Notice>
          ) : null}
          {configUnreadableAt === undefined ? null : (
            <Notice tone="error">
              Your newest published settings could not be read, so the assistant may not answer.
              Open Settings and save them again.
            </Notice>
          )}
          {content}
        </div>
      </main>
    </div>
  );
}
