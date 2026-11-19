import type { StoreConfig } from '@elisym/askr';
import { type ReactNode, useState } from 'react';
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
import { Notice } from './Notice';
import { PreviewResult } from './PreviewResult';
import { Section } from './Section';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  reload: () => Promise<void>;
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
 * the site proof, the first import's preview, syncing on and off. It is set
 * up in Settings, with the product source it is part of.
 */
export function ConnectorSection({ deps, view, config, reload }: Props) {
  const connector = view.connector;
  /** The last preview, of the connector as it was then. */
  const [preview, setPreview] = useState<{ result: ConnectorSyncResult; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

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

  const runPreview = () =>
    run(async () => {
      setPreview(undefined);
      const { result } = await deps.api.previewConnector();
      setPreview({ result, url: connector.url });
      return '';
    });

  const turnOn = () =>
    run(async () => {
      await deps.api.enableConnector();
      await reload();
      return 'Syncing is on. The first sync starts now.';
    });

  const turnOff = () =>
    run(async () => {
      await deps.api.disableConnector();
      setPreview(undefined);
      await reload();
      return 'Syncing is off. Your products stay as last synced.';
    });

  // The settings this session signed last count before the relay has them: a save in Settings
  // changes the connector at once, the relay a moment later.
  const signed = newestConfig(config, deps.journal);
  const problem =
    signed === undefined ? undefined : disagreement(signed, connector, view.catalogKey);
  const active = view.status === 'active';
  // A preview is of the connector as it was: one of another address is no ground to turn it on.
  const previewOk = preview?.result.status === 'ok' && preview.url === connector.url;

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
      <Notice tone="info">
        Previews and syncs run once your store is{' '}
        {view.status === 'pending' ? 'activated' : 'active again'}.
      </Notice>
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
        description="Preview what the first import would publish, then turn syncing on. Nothing is published by a preview."
      >
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        {done === '' ? null : <Notice tone="success">{done}</Notice>}
        <div className="flex flex-wrap gap-8">
          <button
            type="button"
            className="btn"
            disabled={busy || !active || problem !== undefined}
            onClick={() => void runPreview()}
          >
            Preview first import
          </button>
          {connector.enabled ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void turnOff()}>
              Turn off syncing
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !active || problem !== undefined || !previewOk}
              onClick={() => void turnOn()}
            >
              Turn on syncing
            </button>
          )}
        </div>
      </Section>
      {preview === undefined ? null : (
        <Section
          title="First import preview"
          description={`Of ${preview.url}. Nothing is published yet.`}
        >
          <PreviewResult result={preview.result} />
        </Section>
      )}
    </div>
  );
}
