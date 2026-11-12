import type { CatalogItemInput, StoreConfig, SyncDiff } from '@elisym/askr';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CURRENCY } from '../constants';
import { importItems, removeItem, upsertItem } from '../lib/catalog';
import type { SessionDeps } from '../lib/deps';
import { errorMessage, invalidItemIssues } from '../lib/errors';
import { SOURCE_LABELS } from '../lib/labels';
import { inputOfListing, readListings } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { CsvImport } from './CsvImport';
import { DiffSummary } from './DiffSummary';
import { Notice } from './Notice';
import { ProductEditor } from './ProductEditor';
import { ProductList } from './ProductList';
import { Section } from './Section';
import { SyncStatus } from './SyncStatus';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  reload: () => Promise<void>;
}

type Editing = { mode: 'new' } | { mode: 'edit'; item: CatalogItemInput } | undefined;

/**
 * The catalog of the server K (source `admin`). The catalog API replaces the
 * whole catalog, so the draft starts from every listing K shows on the relay
 * and the whole draft is sent, first as a dry run, then for real.
 */
export function ProductsSection({ deps, view, config, reload }: Props) {
  const [draft, setDraft] = useState<CatalogItemInput[]>();
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [diff, setDiff] = useState<SyncDiff>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  const read = useCallback(async () => {
    try {
      const listings = await readListings(deps.reader, view.catalogKey);
      setDraft(listings.map(inputOfListing).sort((left, right) => left.d.localeCompare(right.d)));
      setReadError('');
    } catch {
      setDraft(undefined);
      setReadError(
        'Your current products could not be read from the relay. Nothing can be changed until they are, since a save replaces the whole catalog.',
      );
    }
  }, [deps, view.catalogKey]);

  const isAdminSource = config?.source.kind === 'admin';
  useEffect(() => {
    if (isAdminSource) {
      void read();
    }
  }, [isAdminSource, read]);

  if (!isAdminSource) {
    return (
      <Section title="Products">
        <Notice tone="info">
          {config === undefined
            ? 'The product editor works once your settings, with products managed here in the admin, are published.'
            : `Your products come from: ${SOURCE_LABELS[config.source.kind]}. The editor here is for products managed in the admin; change the product source in Settings to use it.`}
        </Notice>
      </Section>
    );
  }

  const change = (next: CatalogItemInput[]) => {
    setDraft(next);
    setDiff(undefined);
    setNotice('');
  };

  const send = async (dryRun: boolean) => {
    if (draft === undefined) {
      return;
    }
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      const result = await deps.api.catalog(draft, dryRun);
      if (dryRun) {
        setDiff(result.diff);
      } else {
        setDiff(undefined);
        setNotice('Publishing started. Progress shows below.');
        await reload();
      }
    } catch (failure) {
      setError(errorMessage(failure));
      setIssues(invalidItemIssues(failure));
    } finally {
      setBusy(false);
    }
  };

  const running = view.catalogSync?.state === 'running';
  const currency = config?.currency ?? DEFAULT_CURRENCY;
  const maxProducts = view.tier?.maxProducts;

  return (
    <div className="flex flex-col gap-16">
      <Section
        title="Products"
        description="Changes stay here until you review and publish them. Publishing replaces your whole catalog: a product you remove here is hidden from the assistant."
      >
        {readError === '' ? null : (
          <Notice tone="error">
            {readError}{' '}
            <button type="button" className="underline" onClick={() => void read()}>
              Retry
            </button>
          </Notice>
        )}
        {draft === undefined ? null : (
          <>
            <p className="text-13 text-text-2">
              {draft.length} product{draft.length === 1 ? '' : 's'}
              {maxProducts === undefined ? '' : ` of ${maxProducts} your plan allows`}
            </p>
            <ProductList
              items={draft}
              onEdit={(d) => {
                const item = draft.find((candidate) => candidate.d === d);
                setEditing(item === undefined ? undefined : { mode: 'edit', item });
              }}
              onRemove={(d) => change(removeItem(draft, d))}
            />
            {editing === undefined ? (
              <div>
                <button type="button" className="btn" onClick={() => setEditing({ mode: 'new' })}>
                  Add a product
                </button>
              </div>
            ) : (
              <ProductEditor
                key={editing.mode === 'edit' ? editing.item.d : 'new'}
                initial={editing.mode === 'edit' ? editing.item : undefined}
                currency={currency}
                takenIds={draft.map((item) => item.d)}
                onSave={(item) => {
                  change(upsertItem(draft, item));
                  setEditing(undefined);
                }}
                onCancel={() => setEditing(undefined)}
              />
            )}
            <CsvImport
              currency={currency}
              onImport={(items, mode) => change(importItems(draft, items, mode))}
            />
          </>
        )}
      </Section>

      <Section title="Publish">
        <SyncStatus sync={view.catalogSync} />
        {diff === undefined ? null : <DiffSummary diff={diff} />}
        {error === '' ? null : (
          <Notice tone="error">
            {error}
            {issues.length === 0 ? null : (
              <ul className="mt-4">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
        {notice === '' ? null : <Notice tone="success">{notice}</Notice>}
        <div className="flex gap-8">
          <button
            type="button"
            className="btn"
            disabled={busy || running || draft === undefined}
            onClick={() => void send(true)}
          >
            Review changes
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || running || diff === undefined}
            onClick={() => void send(false)}
          >
            Publish
          </button>
        </div>
      </Section>
    </div>
  );
}
