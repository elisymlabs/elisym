import type { StoreConfig } from '@elisym/askr';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SYNC_POLL_MS } from '../constants';
import { ApiError } from '../lib/api';
import { Pause, WAIT_MAX_POLLS } from '../lib/catalog-writer';
import { connectorResultSentence } from '../lib/connector';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import { PLATFORM_LABELS } from '../lib/labels';
import { newestConfig } from '../lib/save';
import { npubOf } from '../lib/signer';
import type { ConnectorRecord, ConnectorSyncResult, StoreView } from '../lib/types';
import { ConnectorStatus } from './ConnectorStatus';
import { CopyBlock } from './CopyBlock';
import { NavIcon } from './NavIcon';
import { NeedsActiveStore } from './NeedsActiveStore';
import { Notice } from './Notice';
import { PreviewResult } from './PreviewResult';
import { Section } from './Section';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  reload: () => Promise<void>;
  /** Opens Overview, where a store with no plan chooses one. */
  onChoosePlan?: () => void;
  /** Between two previews refused by a running sync; tests pass a short one. */
  pollMs?: number;
}

/** `{origin}{path}` without a trailing slash: how the server compares a shop's address. */
function shopIdentity(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * Why the server would refuse to sync this connector with these settings
 * (`configRefusal` in the server's connector service), in the merchant's words.
 * Settings saved here never disagree; settings signed elsewhere (the SDK, an
 * agent) might.
 */
function disagreement(
  config: StoreConfig,
  connector: ConnectorRecord,
  serverKey: string,
): string | undefined {
  const { source } = config;
  if (source.kind !== 'connector' || source.platform !== connector.platform) {
    return 'Your settings do not name this connector as your product source.';
  }
  if (config.catalogKey !== serverKey) {
    return 'Your settings name another key for your products than the one this connector publishes with.';
  }
  if (connector.platform !== 'google' && source.shopUrl === undefined) {
    return 'Your settings do not name your shop address.';
  }
  if (
    source.shopUrl !== undefined &&
    shopIdentity(source.shopUrl) !== shopIdentity(connector.url)
  ) {
    return 'Your settings name another shop address than this connector.';
  }
  return undefined;
}

/**
 * A Shopify, WooCommerce or Google feed connector at work (7.4): its status,
 * the site proof, syncing on and off. It is set up in Settings, with the
 * product source it is part of. Turning syncing on checks the shop first.
 */
export function ConnectorSection({
  deps,
  view,
  config,
  reload,
  onChoosePlan,
  pollMs = SYNC_POLL_MS,
}: Props) {
  const connector = view.connector;
  /** Why the last check did not turn syncing on. */
  const [refused, setRefused] = useState<{ result: ConnectorSyncResult; url: string }>();
  const [busy, setBusy] = useState(false);
  /** Turn on syncing is checking the shop: Cancel stops it before anything is turned on. */
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  /** The check in progress, stopped by Cancel and by leaving the page. */
  const check = useRef<Pause | undefined>(undefined);
  useEffect(() => () => check.current?.stop(), []);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      setDone(await work());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  if (connector === null) {
    return (
      <div className="card flex flex-col items-center gap-12 px-24 py-48 text-center">
        <span className="bg-surface-2 text-text-2 flex size-40 items-center justify-center rounded-full">
          <NavIcon tab="connector" />
        </span>
        <div className="flex max-w-420 flex-col gap-4">
          <h2 className="text-15 font-semibold">No shop is connected</h2>
          <p className="text-13 text-text-2">
            To keep your products in sync with a Shopify or WooCommerce shop or a Google product
            feed, choose it as your product source in Settings and save.
          </p>
        </div>
      </div>
    );
  }

  /** A preview first; a running sync (one per store) is waited out up to 30 s. */
  const previewed = async (pause: Pause): Promise<ConnectorSyncResult | undefined> => {
    for (let polls = 0; ; polls += 1) {
      try {
        return (await deps.api.previewConnector()).result;
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.code === 'sync_running')) {
          throw failure;
        }
        if (polls >= WAIT_MAX_POLLS) {
          throw failure;
        }
      }
      await pause.sleep(pollMs);
      if (pause.stopped) {
        return undefined;
      }
    }
  };

  const turnOn = () =>
    run(async () => {
      const pause = new Pause();
      check.current = pause;
      setRefused(undefined);
      setChecking(true);
      try {
        const url = connector.url;
        const result = await previewed(pause);
        // Cancelled, or the page was left, before the shop's answer: nothing is turned on.
        if (result === undefined || pause.stopped) {
          return '';
        }
        if (result.status !== 'ok') {
          setRefused({ result, url });
          return '';
        }
        // Turning on has begun: Cancel can no longer stop it, so it goes.
        setChecking(false);
        await deps.api.enableConnector();
        await reload();
        return `Syncing is on. ${connectorResultSentence(result)} The first sync starts now.`;
      } finally {
        if (check.current === pause) {
          check.current = undefined;
        }
        setChecking(false);
      }
    });

  const turnOff = () =>
    run(async () => {
      await deps.api.disableConnector();
      setRefused(undefined);
      await reload();
      return 'Syncing is off. Your products stay as last synced.';
    });

  // The settings this session signed last count before the relay has them: a save in Settings
  // changes the connector at once, the relay a moment later.
  const signed = newestConfig(config, deps.journal);
  const problem =
    signed === undefined ? undefined : disagreement(signed, connector, view.catalogKey);
  const active = view.status === 'active';

  let statusNotice: ReactNode = null;
  if (problem !== undefined) {
    statusNotice = (
      <Notice tone="warn">
        {problem} Syncs are refused until they agree: open Settings, check your product source and
        save.
      </Notice>
    );
  } else if (!active) {
    statusNotice = (
      <NeedsActiveStore
        view={view}
        noun="connect your shop"
        {...(onChoosePlan === undefined ? {} : { onChoosePlan })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-32">
      <Section
        title={`${PLATFORM_LABELS[connector.platform]} connector`}
        info={HELP.connector}
        description="Askr reads only what your shop shows the public, with no access token, and keeps your products in sync. Change the shop or its options in Settings."
      >
        <ConnectorStatus connector={connector} tier={view.tier} />
        {statusNotice}
      </Section>
      <Section title="Prove the site is yours" info={HELP.siteProof}>
        <p className="text-13 text-text-2">
          Add this tag to your shop&apos;s home page, or serve a small text file at
          /.well-known/askr with your Store ID on a line of its own. Keep it there: every sync
          checks it.
          {connector.platform === 'google'
            ? ' For a feed, every site its products link to needs it.'
            : ''}
        </p>
        <CopyBlock
          label="Meta tag"
          text={`<meta name="askr-verification" content="${npubOf(view.owner)}">`}
        />
      </Section>
      <Section
        title="Sync"
        info={HELP.sync}
        description="Turn on syncing checks your shop first and turns on only if it can be read and fits your plan."
      >
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        {done === '' ? null : <Notice tone="success">{done}</Notice>}
        {refused === undefined ? null : (
          <div className="flex flex-col gap-8">
            <p className="text-14">Syncing stays off. What {refused.url} answered:</p>
            <PreviewResult result={refused.result} />
          </div>
        )}
        <div className="flex flex-wrap gap-8">
          {connector.enabled ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void turnOff()}>
              Turn off syncing
            </button>
          ) : null}
          {!connector.enabled && active ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || problem !== undefined}
              onClick={() => void turnOn()}
            >
              {checking ? 'Checking your shop...' : 'Turn on syncing'}
            </button>
          ) : null}
          {checking ? (
            <button type="button" className="btn" onClick={() => check.current?.stop()}>
              Cancel
            </button>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
