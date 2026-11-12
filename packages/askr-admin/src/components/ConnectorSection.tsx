import type { ConnectorPlatform, StoreConfig } from '@elisym/askr';
import { useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { PLATFORM_OPTIONS, platformOf } from '../lib/labels';
import { npubOf } from '../lib/signer';
import type { ConnectorSyncResult, StoreView } from '../lib/types';
import { ConnectorStatus } from './ConnectorStatus';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';
import { PreviewResult } from './PreviewResult';
import { Section } from './Section';
import { SelectField } from './SelectField';
import { TextField } from './TextField';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  reload: () => Promise<void>;
}

/** A Shopify, WooCommerce or Google feed connector (7.4): set up, preview, turn on, remove. */
export function ConnectorSection({ deps, view, config, reload }: Props) {
  const saved = view.connector;
  const [platform, setPlatform] = useState<ConnectorPlatform>(
    saved?.platform ?? config?.source.platform ?? 'shopify',
  );
  const [url, setUrl] = useState(saved?.url ?? config?.source.shopUrl ?? '');
  const [currency, setCurrency] = useState(saved?.currency ?? '');
  const [importPolicies, setImportPolicies] = useState(saved?.importPolicies ?? true);
  /** The last preview, with the saved address it was of. */
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

  // A preview is of the saved connector: any change means a new preview before syncing turns on.
  const edited =
    <Value,>(set: (value: Value) => void) =>
    (value: Value) => {
      set(value);
      setPreview(undefined);
    };

  const save = () =>
    run(async () => {
      setPreview(undefined);
      const trimmedCurrency = currency.trim().toUpperCase();
      await deps.api.putConnector({
        platform,
        url: url.trim(),
        ...(trimmedCurrency === '' ? {} : { currency: trimmedCurrency }),
        importPolicies,
      });
      await reload();
      return 'Connector saved. Preview the first import next.';
    });

  const runPreview = () =>
    run(async () => {
      setPreview(undefined);
      const { result } = await deps.api.previewConnector();
      setPreview({ result, url: saved?.url ?? '' });
      return '';
    });

  const enable = () =>
    run(async () => {
      await deps.api.enableConnector();
      await reload();
      return 'Syncing is on. The first sync starts now.';
    });

  const remove = () =>
    run(async () => {
      await deps.api.deleteConnector();
      setPreview(undefined);
      await reload();
      return 'Connector removed. Products already published stay until you change them.';
    });

  // Preview and syncing act on the saved connector: while the form differs, it must be saved first.
  const unsaved =
    saved === null ||
    platform !== saved.platform ||
    url.trim() !== saved.url ||
    currency.trim().toUpperCase() !== (saved.currency ?? '') ||
    importPolicies !== saved.importPolicies;

  const sourceMismatch =
    config !== undefined &&
    (config.source.kind !== 'connector' || config.source.platform !== platform);

  return (
    <div className="flex flex-col gap-16">
      <Section title="Connector status">
        <ConnectorStatus connector={saved} />
      </Section>
      <Section
        title="Connect your shop"
        description="Askr reads only what your shop shows the public, with no access token, and keeps your products in sync."
      >
        {sourceMismatch ? (
          <Notice tone="warn">
            Your settings do not name this connector as the product source. In Settings, choose your
            shop as the product source (with its shop address) and save, or syncs are refused.
          </Notice>
        ) : null}
        <SelectField
          id="connector-platform"
          label="Platform"
          value={platform}
          options={PLATFORM_OPTIONS}
          onChange={edited((value: string) => setPlatform(platformOf(value) ?? platform))}
        />
        <TextField
          id="connector-url"
          label={platform === 'google' ? 'Feed address' : 'Shop address'}
          value={url}
          placeholder={
            platform === 'google' ? 'https://shop.example/feed.xml' : 'https://shop.example'
          }
          onChange={edited(setUrl)}
        />
        <TextField
          id="connector-currency"
          label="Currency override (optional)"
          value={currency}
          hint="Only if the shop reports another currency than it sells in."
          onChange={edited(setCurrency)}
        />
        {platform === 'shopify' ? (
          <label className="text-14 flex items-center gap-8">
            <input
              type="checkbox"
              checked={importPolicies}
              onChange={(event) => edited(setImportPolicies)(event.target.checked)}
            />
            Import the shop's refund, shipping, privacy and terms pages as policies
          </label>
        ) : null}
        <div className="flex flex-col gap-8">
          <p className="text-14 font-medium">Prove the site is yours</p>
          <p className="text-13 text-text-2">
            Add this tag to your shop's home page, or serve your store ID at /.well-known/askr.
            {platform === 'google'
              ? ' For a feed, every site its product links point to needs it.'
              : ''}
          </p>
          <CopyBlock
            label="Meta tag"
            text={`<meta name="askr-verification" content="${npubOf(view.owner)}">`}
          />
        </div>
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        {done === '' ? null : <Notice tone="success">{done}</Notice>}
        {saved !== null && unsaved ? (
          <Notice tone="info">Save the connector to preview these settings.</Notice>
        ) : null}
        <div className="flex flex-wrap gap-8">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || url.trim() === ''}
            onClick={() => void save()}
          >
            Save connector
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || unsaved}
            onClick={() => void runPreview()}
          >
            Preview first import
          </button>
          <button
            type="button"
            className="btn"
            disabled={
              busy || unsaved || saved === null || saved.enabled || preview?.result.status !== 'ok'
            }
            onClick={() => void enable()}
          >
            Turn on syncing
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || saved === null}
            onClick={() => void remove()}
          >
            Remove
          </button>
        </div>
      </Section>
      {preview === undefined ? null : (
        <Section
          title="First import preview"
          description={`Of ${preview.url}, as saved. Nothing is published yet.`}
        >
          <PreviewResult result={preview.result} />
        </Section>
      )}
    </div>
  );
}
