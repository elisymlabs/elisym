import type { StoreConfig } from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { BillingReturn } from '../lib/billing';
import type { CatalogQueue } from '../lib/catalog-writer';
import type { SessionDeps } from '../lib/deps';
import type { PlanIntent } from '../lib/plan-intent';
import { isRemembered } from '../lib/remembered';
import { npubOf } from '../lib/signer';
import { TABS, type TabId } from '../lib/tabs';
import type { StoreView } from '../lib/types';
import { AskrMark } from './AskrMark';
import { BillingSection } from './BillingSection';
import { BudgetBanner } from './BudgetBanner';
import { ConnectorSection } from './ConnectorSection';
import { ContactEmailSection } from './ContactEmailSection';
import { EmbedSection } from './EmbedSection';
import { KeysSection } from './KeysSection';
import { Notice } from './Notice';
import { Overview } from './Overview';
import { PoliciesSection } from './PoliciesSection';
import { ProductsSection } from './ProductsSection';
import { type RefreshStatus, RefreshState } from './RefreshState';
import { SettingsSection } from './SettingsSection';
import { TabBar } from './TabBar';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  /** The published config, if the relay has one. */
  config: StoreConfig | undefined;
  /** The config is read from what the server holds for the relay (not active, or not all published). */
  configFromServer: boolean;
  /** The server left older stored events out of its read-back for size. */
  storedTruncated: boolean;
  configError: string;
  /** Set when the relay's newest config does not parse: its date (`config` is then an older one). */
  configUnreadableAt: number | undefined;
  /** A later refresh failed: the view shown is the last one read. */
  reloadWarning: string;
  /** True once the store was read again. */
  reload: () => Promise<boolean>;
  /** True once the settings were read again. */
  reloadConfig: () => Promise<boolean>;
  onSignOut: () => void;
  onReplaceKey: () => void;
  /** The session's catalog writes: without it products cannot be published from here. */
  catalogQueue?: CatalogQueue;
  /** Back from Stripe: what the return says, above every section. */
  billingNotice?: ReactNode;
  /** What the Stripe return said: back from a portal change (`updated`), Billing opens. */
  billingReturn?: BillingReturn;
  /** The paid plan chosen on the landing: Billing opens on it (D4). */
  intent?: PlanIntent;
  /** Its checkout or the portal opened. */
  onIntentDone?: () => void;
}

const REFRESH_SHOWN_MS = 2_000;

const STAYS_REMEMBERED =
  'Signing out keeps your key remembered on this device. Forget it under Advanced.';

const REFRESH_SAID: Readonly<Record<RefreshStatus, string>> = {
  idle: '',
  busy: 'Refreshing...',
  done: 'Up to date.',
  failed: 'Could not refresh.',
};

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
  catalogQueue,
  billingNotice,
  billingReturn,
  intent,
  onIntentDone = () => undefined,
}: Props) {
  // A plan chosen on the landing opens Billing on it, one click from its checkout; a portal
  // change comes back to Billing, where it shows.
  const [chosen, setTab] = useState<TabId>(
    intent !== undefined || billingReturn === 'updated' ? 'billing' : 'overview',
  );
  // The Connector section is for a connector set up in Settings: without one it is left out.
  const tabs = view.connector === null ? TABS.filter((entry) => entry.id !== 'connector') : TABS;
  const tab = tabs.some((entry) => entry.id === chosen) ? chosen : 'overview';
  // A tab that went away is forgotten, so it does not come back by itself with its section.
  useEffect(() => {
    if (tab !== chosen) {
      setTab(tab);
    }
  }, [tab, chosen]);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>('idle');
  // Read at each render; forgetting it under Advanced renders again.
  const [, setForgottenTimes] = useState(0);
  const remembered = isRemembered(deps.signer.pubkey);
  /** Set at once on a press: a second press while it reads starts no second read. */
  const refreshing = useRef(false);
  // The check or cross stays a moment, then goes.
  useEffect(() => {
    if (refreshStatus !== 'done' && refreshStatus !== 'failed') {
      return undefined;
    }
    const timer = setTimeout(() => setRefreshStatus('idle'), REFRESH_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [refreshStatus]);
  const pressRefresh = async () => {
    if (refreshing.current) {
      return;
    }
    refreshing.current = true;
    setRefreshStatus('busy');
    try {
      const read = await reload();
      const configRead = await reloadConfig();
      setRefreshStatus(read && configRead ? 'done' : 'failed');
    } catch {
      // Neither read throws today; if one ever does, the spinner must not stay.
      setRefreshStatus('failed');
    } finally {
      refreshing.current = false;
    }
  };
  const retryConfig = async () => {
    await reloadConfig();
  };
  const reloadView = async () => {
    await reload();
  };
  const refresh = useCallback(async () => {
    await reload();
    await reloadConfig();
  }, [reload, reloadConfig]);
  // Products, policies and the connector wait for a plan, which is chosen in Billing.
  const choosePlan = () => setTab('billing');
  let content;
  if (tab === 'overview') {
    content = (
      <Overview
        view={view}
        config={config}
        configFromServer={configFromServer}
        onOpenBilling={choosePlan}
        catalogReader={{ reader: deps.reader, now: deps.now }}
      />
    );
  } else if (tab === 'billing') {
    content = (
      <BillingSection
        deps={deps}
        view={view}
        settingsSaved={config !== undefined}
        configError={configError}
        // Activation publishes the stored config, so the settings are read again too (6.5).
        onPlanChosen={refresh}
        {...(intent === undefined ? {} : { intent })}
        onIntentDone={onIntentDone}
      />
    );
  } else if (tab === 'settings') {
    content = (
      <div className="flex flex-col gap-32">
        <ContactEmailSection deps={deps} view={view} onSaved={reloadView} />
        <SettingsSection
          deps={deps}
          view={view}
          config={config}
          configError={configError}
          configUnreadableAt={configUnreadableAt}
          onRetry={retryConfig}
          onSaved={refresh}
        />
      </div>
    );
  } else if (tab === 'products') {
    content = (
      <ProductsSection
        deps={deps}
        view={view}
        config={config}
        onChoosePlan={choosePlan}
        {...(catalogQueue === undefined ? {} : { queue: catalogQueue })}
      />
    );
  } else if (tab === 'policies') {
    content = <PoliciesSection deps={deps} view={view} config={config} onChoosePlan={choosePlan} />;
  } else if (tab === 'connector') {
    content = (
      <ConnectorSection
        deps={deps}
        view={view}
        config={config}
        reload={reloadView}
        onChoosePlan={choosePlan}
      />
    );
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
        onRetry={retryConfig}
        onChanged={refresh}
        onReplaceKey={onReplaceKey}
        onForgotten={() => setForgottenTimes((times) => times + 1)}
      />
    );
  } else {
    content = <EmbedSection api={deps.api} view={view} config={config} />;
  }
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];
  return (
    // On a wide screen the page itself never scrolls: the sidebar and the content each scroll in
    // their own column, so the sidebar never slides off with an overscroll bounce.
    <div className="flex min-h-screen flex-col md:h-screen md:flex-row md:overflow-hidden">
      <aside className="bg-sidebar border-line relative flex flex-col gap-16 border-b px-16 py-16 md:h-full md:w-248 md:flex-none md:overflow-y-auto md:overscroll-contain md:border-r md:border-b-0 md:px-12 md:py-20">
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
            className="text-13 text-text-2 hover:bg-hover hover:text-text rounded-8 flex items-center justify-between gap-8 px-10 py-7 text-left transition-colors"
            aria-busy={refreshStatus === 'busy'}
            onClick={() => void pressRefresh()}
          >
            Refresh
            <RefreshState status={refreshStatus} />
          </button>
          <button
            type="button"
            className="text-13 text-text-2 hover:bg-hover hover:text-text rounded-8 px-10 py-7 text-left transition-colors"
            onClick={onSignOut}
          >
            Sign out
          </button>
          {remembered ? <p className="text-12 text-text-3 px-10">{STAYS_REMEMBERED}</p> : null}
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col gap-28 px-16 py-24 md:h-full md:overflow-y-auto md:overscroll-contain md:px-48 md:py-40">
        <p className="sr-only" role="status">
          {REFRESH_SAID[refreshStatus]}
        </p>
        <header className="flex flex-wrap items-start justify-between gap-12">
          <div className="flex max-w-640 flex-col gap-4">
            <h1 className="text-24 font-semibold tracking-tight">{current.label}</h1>
            <p className="text-14 text-text-2">{current.description}</p>
          </div>
          <div className="flex gap-8 md:hidden">
            <button
              type="button"
              className="btn"
              aria-busy={refreshStatus === 'busy'}
              onClick={() => void pressRefresh()}
            >
              Refresh
              <RefreshState status={refreshStatus} />
            </button>
            <button type="button" className="btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
          {remembered ? (
            <p className="text-12 text-text-3 w-full md:hidden">{STAYS_REMEMBERED}</p>
          ) : null}
        </header>
        <div className="flex max-w-760 flex-col gap-32">
          {billingNotice}
          <BudgetBanner view={view} now={deps.now()} />
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
