import type { CatalogItemInput, StoreConfig, SyncDiff } from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CURRENCY } from '../constants';
import { importItems, removeItem, upsertItem } from '../lib/catalog';
import type { SessionDeps } from '../lib/deps';
import { errorMessage, invalidItemIssues } from '../lib/errors';
import { SOURCE_LABELS } from '../lib/labels';
import { readListings } from '../lib/store-data';
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

/** A dry run's answer, with exactly the list it was for: Publish sends that list. */
interface Reviewed {
  items: CatalogItemInput[];
  diff: SyncDiff;
}

/**
 * The catalog of the server K (source `admin`). The catalog API replaces the
 * whole catalog, so the draft starts from every listing K shows on the relay
 * and the whole draft is sent, first as a dry run, then for real.
 */
export function ProductsSection({ deps, view, config, reload }: Props) {
  const [draft, setDraft] = useState<CatalogItemInput[]>();
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [reviewed, setReviewed] = useState<Reviewed>();
  const [busy, setBusy] = useState(false);
  /** What the last publish sent: offered back if that sync fails and the list is read again. */
  const [lastSent, setLastSent] = useState<{ items: CatalogItemInput[]; readsBefore: number }>();
  /** Whole reads of the catalog so far: tells whether the list was read again after a publish. */
  const [reads, setReads] = useState(0);
  // The draft as it is now, for a dry-run answer to check it is still about the current list.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  const read = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const listings = await readListings(deps.reader, view.catalogKey, deps.now());
        if (isCurrent()) {
          setDraft(listings.sort((left, right) => left.d.localeCompare(right.d)));
          setReads((count) => count + 1);
          setReadError('');
        }
      } catch {
        if (isCurrent()) {
          setDraft(undefined);
          setReadError(
            'Your current products could not be read from the relay. Nothing can be changed until they are, since a save replaces the whole catalog.',
          );
        }
      }
    },
    [deps, view.catalogKey],
  );

  const isAdminSource = config?.source.kind === 'admin';
  const running = view.catalogSync?.state === 'running';
  // While a sync publishes, the relay holds a half-written catalog: a draft read from it would
  // hide the rest on the next publish. Read only once no sync runs, and again after each one.
  useEffect(() => {
    if (!isAdminSource) {
      return undefined;
    }
    setDraft(undefined);
    setReviewed(undefined);
    setEditing(undefined);
    if (running) {
      return undefined;
    }
    let current = true;
    void read(() => current);
    return () => {
      current = false;
    };
  }, [isAdminSource, running, read]);

  // A publish that went through needs no restore offer.
  const syncState = view.catalogSync?.state;
  useEffect(() => {
    if (syncState === 'done') {
      setLastSent(undefined);
    }
  }, [syncState]);

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
    // No edit while a review or publish is in flight: its answer is about the list it was sent.
    if (busy) {
      return;
    }
    setDraft(next);
    setReviewed(undefined);
    setNotice('');
  };

  const review = async () => {
    const sent = draft;
    if (sent === undefined) {
      return;
    }
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      const result = await deps.api.catalog(sent, true);
      // An answer about a list that has changed since is dropped, never shown as this one's.
      if (draftNow.current === sent) {
        setReviewed({ items: sent, diff: result.diff });
      }
    } catch (failure) {
      setError(errorMessage(failure));
      setIssues(invalidItemIssues(failure));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (reviewed === undefined) {
      return;
    }
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      await deps.api.catalog(reviewed.items, false);
      setLastSent({ items: reviewed.items, readsBefore: reads });
      setReviewed(undefined);
      setNotice('Publishing started. Progress shows below.');
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
      setIssues(invalidItemIssues(failure));
    } finally {
      setBusy(false);
    }
  };

  let failedNotice: ReactNode = null;
  if (view.catalogSync?.state === 'failed' && lastSent !== undefined && draft !== undefined) {
    failedNotice =
      reads > lastSent.readsBefore ? (
        <Notice tone="warn">
          The last publish failed, so the list below was read again from the relay and may miss
          changes that did not go out.{' '}
          <button type="button" className="underline" onClick={() => change(lastSent.items)}>
            Restore the list you tried to publish
          </button>
        </Notice>
      ) : (
        <Notice tone="warn">
          The last publish failed. The list below is the one you tried to publish: review and
          publish it again.
        </Notice>
      );
  }

  const currency = config?.currency ?? DEFAULT_CURRENCY;
  const maxProducts = view.tier?.maxProducts;

  return (
    <div className="flex flex-col gap-16">
      <Section
        title="Products"
        description="Changes stay here until you review and publish them. Publishing replaces your whole catalog: a product you remove here is deleted for good when you publish. To take one off sale for a while, set its availability to hidden instead."
      >
        {running ? (
          <Notice tone="info">
            Products are being published. The editor opens again once that is done.
          </Notice>
        ) : null}
        {readError === '' ? null : (
          <Notice tone="error">
            {readError}{' '}
            <button type="button" className="underline" onClick={() => void read()}>
              Retry
            </button>
          </Notice>
        )}
        {failedNotice}
        {draft === undefined ? null : (
          <fieldset disabled={busy} className="contents">
            <p className="text-13 text-text-2">
              {draft.length} product{draft.length === 1 ? '' : 's'}
              {maxProducts === undefined ? '' : ` of ${maxProducts} your plan allows`}. Products set
              to hidden stay listed so you can show them again; removing one deletes it.
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
              current={draft}
              onImport={(items, mode) => change(importItems(draft, items, mode))}
            />
          </fieldset>
        )}
      </Section>

      <Section title="Publish">
        <SyncStatus sync={view.catalogSync} />
        {reviewed === undefined ? null : <DiffSummary diff={reviewed.diff} />}
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
            onClick={() => void review()}
          >
            Review changes
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || running || reviewed === undefined}
            onClick={() => void publish()}
          >
            Publish
          </button>
        </div>
      </Section>
    </div>
  );
}
