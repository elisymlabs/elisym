import type { CatalogItemInput, StoreConfig } from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CURRENCY } from '../constants';
import { ApiError } from '../lib/api';
import { changesOf, importItems, removeItem, upsertItem } from '../lib/catalog';
import {
  type CatalogOp,
  type CatalogQueue,
  type CatalogRead,
  type Outcome,
  type Pause,
  type QueueEntry,
  WAIT_MAX_POLLS,
  type WriteProgress,
} from '../lib/catalog-writer';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import { SOURCE_LABELS } from '../lib/labels';
import { readCatalog } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { useQueueEntries } from '../lib/use-catalog-queue';
import { CsvImport, type ReplacePrepared } from './CsvImport';
import { InfoTip } from './InfoTip';
import { NeedsActiveStore } from './NeedsActiveStore';
import { Notice } from './Notice';
import { ProductEditor } from './ProductEditor';
import { ProductList } from './ProductList';
import type { RowStatus } from './ProductRowActions';
import { Section } from './Section';
import { SyncStatus } from './SyncStatus';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  /** The session's catalog writes; without it nothing can be published from here. */
  queue?: CatalogQueue;
  /** Opens Billing, where a store with no plan chooses one. */
  onChoosePlan?: () => void;
}

/** The open editor; `entryId` is its save in the queue, while on its way or after it failed. */
type Editing =
  | { mode: 'new'; draft?: CatalogItemInput; entryId?: number; notSent?: boolean }
  | { mode: 'edit'; item: CatalogItemInput; entryId?: number; notSent?: boolean }
  | undefined;

const UNKNOWN_SAVE = 'Sent, but whether it went through could not be read. Press Refresh to check.';
const UNKNOWN_IMPORT = 'The import was sent; its result could not be read. Press Refresh to check.';

function byId(items: readonly CatalogItemInput[]): CatalogItemInput[] {
  return [...items].sort((left, right) => left.d.localeCompare(right.d));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** What a queued save or import is doing, in the merchant's words. */
function progressText(progress: WriteProgress): string {
  if (progress.state === 'queued' || progress.state === 'waiting-sync') {
    return 'Waiting for the products being published';
  }
  if (progress.state === 'setting-up') {
    return 'Your store is being set up, your change goes out in a moment';
  }
  return 'Publishing...';
}

/** What a queued removal is doing, on its row. */
function removalText(progress: WriteProgress): string {
  return progress.state === 'sending' || progress.state === 'publishing'
    ? 'Removing...'
    : 'Waiting...';
}

const RECOUNTED =
  'Your products changed while Replace all waited; choose the file again to confirm the new count.';

/** How an import that did not go through ended, for the page when its panel is gone. */
function importEndText(outcome: Outcome): string {
  if (outcome.kind === 'failed') {
    return outcome.message;
  }
  return outcome.kind === 'recount' ? RECOUNTED : UNKNOWN_IMPORT;
}

function savedText(item: CatalogItemInput): string {
  return item.visibility === 'hidden'
    ? `Saved. ${item.title} is hidden from the chat.`
    : `Saved. ${item.title} is live in the chat.`;
}

/** The product IDs a write touches: their rows take no other action meanwhile. */
function idsOf(op: CatalogOp): string[] {
  if (op.kind === 'save') {
    return [op.item.d];
  }
  if (op.kind === 'remove') {
    return op.ids;
  }
  return op.items.map((item) => item.d);
}

function editorOf(op: Extract<CatalogOp, { kind: 'save' }>, entryId: number): Editing {
  return op.isNew
    ? { mode: 'new', draft: op.item, entryId }
    : { mode: 'edit', item: op.item, entryId };
}

/**
 * A failed or unread removal whose products the relay no longer lists went through after all
 * (or was done elsewhere): nothing is left to retry. A removal of unreadable products is done
 * with too once none of them is still unreadable (one may have become readable).
 */
function forgetSettledRemovals(queue: CatalogQueue | undefined, fresh: CatalogRead): void {
  if (queue === undefined) {
    return;
  }
  const listed = new Set(fresh.ids);
  const readable = new Set(fresh.listings.map((item) => item.d));
  for (const entry of queue.entries()) {
    const { op } = entry;
    if (entry.outcome === undefined || op.kind !== 'remove') {
      continue;
    }
    const left = op.ids.filter(
      (d) => listed.has(d) && !(op.unreadable === true && readable.has(d)),
    );
    if (left.length === 0) {
      queue.dismiss(entry.id);
    }
  }
}

/** The list after a write that went through, without reading the relay. */
function applied(list: readonly CatalogItemInput[], op: CatalogOp): CatalogItemInput[] {
  if (op.kind === 'save') {
    return byId(upsertItem(list, op.item));
  }
  if (op.kind === 'remove') {
    return op.ids.reduce((left, d) => removeItem(left, d), [...list]);
  }
  return byId(importItems(list, op.items, op.kind));
}

function appliedIds(ids: readonly string[], op: CatalogOp): string[] {
  if (op.kind === 'remove') {
    return ids.filter((d) => !op.ids.includes(d));
  }
  if (op.kind === 'replace') {
    return op.items.map((item) => item.d);
  }
  return [...new Set([...ids, ...idsOf(op)])];
}

/**
 * The catalog of the server K (source `admin`), read from every listing K
 * shows on the relay. Every save, removal and import is published at once,
 * one at a time, through the session's queue (2.1, 2.2).
 */
export function ProductsSection({ deps, view, config, queue, onChoosePlan }: Props) {
  /** The catalog as last read from the relay, with every write that went through applied. */
  const [products, setProducts] = useState<CatalogItemInput[]>();
  /** Every product ID K lists on the relay, readable or not. */
  const [listedIds, setListedIds] = useState<string[]>([]);
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  /** The replace confirmation is open: nothing else may change the count it names. */
  const [replacing, setReplacing] = useState(false);
  /** The unreadable products the open "Remove them?" names; a changed set closes it. */
  const [confirmingUnreadable, setConfirmingUnreadable] = useState<readonly string[]>();
  const entries = useQueueEntries(queue);
  /** Bumped whenever a write's result is applied here: a read started before it is dropped. */
  const generation = useRef(0);
  /** A write ended: the list is read again once nothing is queued, waiting or in flight. */
  const rereadWanted = useRef(false);
  const [rereadTick, setRereadTick] = useState(0);
  /** Imports started from this mount: their own panel shows how they ended, while it is shown. */
  const awaitedHere = useRef(new Map<number, number>());
  /**
   * The import panel on the page: counted at each mount, so an import reports through the very
   * panel that started it, and through the page once that one is gone.
   */
  const importPanel = useRef({ epoch: 0, mounted: false });
  const panelMounted = useCallback((mounted: boolean) => {
    if (mounted) {
      importPanel.current = { epoch: importPanel.current.epoch + 1, mounted: true };
    } else {
      importPanel.current = { ...importPanel.current, mounted: false };
    }
  }, []);
  /** The read a replace's confirmation was worked out against. */
  const replaceSnapshot = useRef<CatalogRead | undefined>(undefined);

  /** What opened the editor: focus goes back to it once the editor closes. */
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const openEditor = (next: Editing) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(next);
  };
  useEffect(() => {
    if (editing !== undefined || opener.current === null) {
      return;
    }
    // A new product's opener, Add a product, was hidden while the editor was open: it is back.
    const target = opener.current.isConnected ? opener.current : addButton.current;
    opener.current = null;
    target?.focus();
  }, [editing]);

  const applyRead = (fresh: CatalogRead) => {
    setProducts(byId(fresh.listings));
    setListedIds(fresh.ids);
    forgetSettledRemovals(queue, fresh);
    setReadError('');
  };

  const read = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      const startedAt = generation.current;
      const stillWanted = () => isCurrent() && startedAt === generation.current;
      try {
        const fresh = await readCatalog(deps.reader, view.catalogKey, deps.now());
        if (stillWanted()) {
          setProducts(byId(fresh.listings));
          setListedIds(fresh.ids);
          setReadError('');
          forgetSettledRemovals(queue, fresh);
        }
      } catch {
        if (stillWanted()) {
          setProducts(undefined);
          setReadError(
            'Your current products could not be read. Nothing can be changed until they are. Retry in a moment.',
          );
        }
      }
    },
    [deps, view.catalogKey, queue],
  );

  const isAdminSource = config?.source.kind === 'admin';
  const running = view.catalogSync?.state === 'running';
  const lastSyncId = view.catalogSync?.syncId ?? null;
  const loaded = products !== undefined;
  /** For the read effect, which runs only when a sync starts or ends. */
  const latest = useRef({ lastSyncId, loaded });
  latest.current = { lastSyncId, loaded };
  // While a sync publishes, the relay holds a half-written catalog: read only once none runs.
  // This is the mount read and the one after a sync someone else started; one of ours already
  // applied its result here, and the list is read again once the queue is idle.
  useEffect(() => {
    if (!isAdminSource || running) {
      return undefined;
    }
    const { lastSyncId: syncId, loaded: hasList } = latest.current;
    if (hasList && syncId !== null && queue?.ownsSync(syncId) === true) {
      return undefined;
    }
    let current = true;
    void read(() => current);
    return () => {
      current = false;
    };
  }, [isAdminSource, running, read, queue]);

  const queueBusy = entries.some((entry) => entry.outcome === undefined);
  useEffect(() => {
    if (!rereadWanted.current || queueBusy || running || !isAdminSource) {
      return;
    }
    rereadWanted.current = false;
    void read();
  }, [rereadTick, queueBusy, running, isAdminSource, read]);

  /** A write's end: applied here at once when this mount saw it end, read again when idle. */
  const finished = (entry: QueueEntry, live: boolean) => {
    const { op, outcome } = entry;
    if (queue === undefined || outcome === undefined) {
      return;
    }
    if (outcome.kind === 'ok' && live) {
      generation.current += 1;
      setProducts((list) => (list === undefined ? list : applied(list, op)));
      setListedIds((ids) => appliedIds(ids, op));
    }
    if (outcome.kind !== 'cancelled' && outcome.kind !== 'recount') {
      rereadWanted.current = true;
      setRereadTick((tick) => tick + 1);
    }
    if (outcome.kind === 'ok') {
      if (op.kind === 'save') {
        setNotice(savedText(op.item));
        setEditing((current) => (current?.entryId === entry.id ? undefined : current));
      } else if (op.kind === 'remove') {
        setNotice(`Removed ${op.label}.`);
      } else {
        setNotice(`Published ${plural(op.items.length, 'product')} from the file.`);
      }
      queue.dismiss(entry.id);
      return;
    }
    // A failed or unread save that ended out of sight opens its editor again, fields kept.
    if (op.kind === 'save' && !live) {
      setEditing((current) => current ?? editorOf(op, entry.id));
    }
    if (op.kind === 'merge' || op.kind === 'replace') {
      // The import's own panel says how it ended when it was started here and is still open.
      const panel = importPanel.current;
      const reportedByPanel =
        live && panel.mounted && awaitedHere.current.get(entry.id) === panel.epoch;
      if (!reportedByPanel) {
        setError(importEndText(outcome));
      }
      queue.dismiss(entry.id);
    }
  };
  const finishedNow = useRef(finished);
  finishedNow.current = finished;

  // Writes already on their way when this mounts (back from another tab) show here; a save opens
  // its editor again.
  useEffect(() => {
    if (queue === undefined) {
      return undefined;
    }
    const seen = new Set<number>();
    const look = (live: boolean) => {
      for (const entry of queue.entries()) {
        if (entry.outcome === undefined) {
          const { op, id } = entry;
          if (!live && op.kind === 'save') {
            setEditing((current) => current ?? editorOf(op, id));
          }
        } else if (!seen.has(entry.id)) {
          seen.add(entry.id);
          finishedNow.current(entry, live);
        }
      }
    };
    look(false);
    return queue.subscribe(() => look(true));
  }, [queue]);

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

  const active = view.status === 'active';
  const canWrite = queue !== undefined && active && products !== undefined;
  const pendingEntries = entries.filter((entry) => entry.outcome === undefined);
  const lockedIds = new Set(pendingEntries.flatMap((entry) => idsOf(entry.op)));
  // The product in the editor: removing it meanwhile and then saving would bring it back.
  if (editing?.mode === 'edit') {
    lockedIds.add(editing.item.d);
  }
  const replacePending = pendingEntries.some((entry) => entry.op.kind === 'replace');
  const productIds = new Set((products ?? []).map((item) => item.d));
  const unreadable = listedIds.filter((d) => !productIds.has(d));
  /**
   * Every removal, newest first: one started from a row covers its product too once that reads
   * as unreadable (replaced elsewhere by a listing the admin cannot read).
   */
  const unreadableRemovals = [...entries].reverse().filter((entry) => entry.op.kind === 'remove');
  const stillUnreadable = (entry: QueueEntry) =>
    entry.op.kind === 'remove' && entry.op.ids.some((d) => unreadable.includes(d));
  /**
   * Unreadable products a write on its way already covers: a removal (never confirmed or sent
   * twice) or an import that publishes a readable version (never deleted right after it).
   */
  const pendingUnreadableIds = new Set(pendingEntries.flatMap((entry) => idsOf(entry.op)));
  const unreadableToRemove = unreadable.filter((d) => !pendingUnreadableIds.has(d));
  const takenIds = [
    ...new Set([
      ...productIds,
      ...listedIds,
      ...pendingEntries
        .filter((entry) => entry.op.kind !== 'remove')
        .flatMap((entry) => idsOf(entry.op)),
    ]),
  ];
  const locked = !canWrite || replacing || replacePending;

  const enqueue = (op: CatalogOp): { id: number; done: Promise<Outcome> } | undefined => {
    if (queue === undefined) {
      return undefined;
    }
    setNotice('');
    setError('');
    const queued = queue.enqueue(op);
    awaitedHere.current.set(queued.id, importPanel.current.epoch);
    return queued;
  };

  const save = async (item: CatalogItemInput) => {
    if (editing === undefined) {
      return;
    }
    const before = products?.find((existing) => existing.d === item.d);
    if (before !== undefined && changesOf([before], [item]).items.length === 0) {
      // A failure shown for this editor goes with it, so it does not reopen later.
      if (editing.entryId !== undefined) {
        queue?.dismiss(editing.entryId);
      }
      setEditing(undefined);
      setNotice(`Nothing changed in ${item.title}.`);
      return;
    }
    if (editing.entryId !== undefined) {
      queue?.dismiss(editing.entryId);
    }
    const queued = enqueue({ kind: 'save', item, isNew: editing.mode === 'new' });
    if (queued === undefined) {
      return;
    }
    setEditing((current) =>
      current === undefined ? current : { ...current, entryId: queued.id, notSent: false },
    );
    await queued.done;
  };

  const remove = (d: string) => {
    const item = products?.find((candidate) => candidate.d === d);
    enqueue({ kind: 'remove', ids: [d], label: item?.title ?? d });
  };

  /**
   * The confirmed unreadable products go; a retry sends only those of its try still listed and
   * still unreadable (one that became readable is shown, and never deleted unasked).
   */
  const removeUnreadable = (previous?: QueueEntry) => {
    setConfirmingUnreadable(undefined);
    let ids = unreadableToRemove;
    if (previous !== undefined) {
      queue?.dismiss(previous.id);
      ids =
        previous.op.kind === 'remove'
          ? previous.op.ids.filter((d) => unreadableToRemove.includes(d))
          : [];
    }
    if (ids.length === 0) {
      return;
    }
    enqueue({
      kind: 'remove',
      ids,
      label: plural(ids.length, 'unreadable product'),
      unreadable: true,
    });
  };

  const importFile = async (
    items: CatalogItemInput[],
    mode: 'merge' | 'replace',
  ): Promise<Outcome> => {
    let op: CatalogOp = { kind: 'merge', items };
    if (mode === 'replace') {
      const fresh = replaceSnapshot.current ?? { listings: products ?? [], ids: listedIds };
      op = {
        kind: 'replace',
        items,
        fresh,
        hidden: changesOf(fresh.listings, items, fresh.ids).hide.length,
      };
    }
    const queued = enqueue(op);
    if (queued === undefined) {
      return { kind: 'cancelled' };
    }
    const outcome = await queued.done;
    if (outcome.kind === 'recount') {
      // The catalog changed while the replace waited: the new count is confirmed first.
      replaceSnapshot.current = outcome.fresh;
      generation.current += 1;
      applyRead(outcome.fresh);
    }
    return outcome;
  };

  /** Before Replace all asks: no sync running (waited out up to 30 s), then a fresh read. */
  const prepareReplace = async (
    items: CatalogItemInput[],
    pause: Pause,
  ): Promise<ReplacePrepared> => {
    const pollMs = queue?.pollMs ?? 0;
    try {
      for (let polls = 0; ; polls += 1) {
        const now = await deps.api.store();
        if (now.catalogSync?.state !== 'running') {
          break;
        }
        if (polls >= WAIT_MAX_POLLS) {
          return { kind: 'failed', message: errorMessage(new ApiError(409, 'sync_running')) };
        }
        await pause.sleep(pollMs);
        if (pause.stopped) {
          return { kind: 'cancelled' };
        }
      }
      const fresh = await readCatalog(deps.reader, view.catalogKey, deps.now());
      if (pause.stopped) {
        return { kind: 'cancelled' };
      }
      replaceSnapshot.current = fresh;
      generation.current += 1;
      applyRead(fresh);
      return { kind: 'ready', hidden: changesOf(fresh.listings, items, fresh.ids).hide.length };
    } catch (failure) {
      return { kind: 'failed', message: errorMessage(failure) };
    }
  };

  const rows = new Map<string, RowStatus>();
  for (const entry of entries) {
    const { op, progress, outcome } = entry;
    // A settled unreadable removal's failure belongs to its notice, even once one of them reads;
    // while it is on its way, a row that became readable shows it, with its Cancel.
    if (
      op.kind !== 'remove' ||
      (op.unreadable === true && outcome !== undefined) ||
      queue === undefined
    ) {
      continue;
    }
    for (const d of op.ids) {
      if (outcome === undefined) {
        rows.set(d, {
          kind: 'pending',
          text: removalText(progress),
          ...(progress.cancellable ? { onCancel: () => queue.cancel(entry.id) } : {}),
        });
      } else if (outcome.kind === 'failed') {
        rows.set(d, {
          kind: 'failed',
          message: outcome.message,
          onRetry: () => {
            queue.dismiss(entry.id);
            enqueue(op);
          },
          onDismiss: () => queue.dismiss(entry.id),
        });
      } else if (outcome.kind === 'unknown') {
        rows.set(d, { kind: 'unknown', onDismiss: () => queue.dismiss(entry.id) });
      }
    }
  }

  const editorEntry =
    editing?.entryId === undefined
      ? undefined
      : entries.find((entry) => entry.id === editing.entryId);
  let editorStatus: { text: string; cancellable: boolean } | undefined;
  let editorFailure: { message: string; issues: readonly string[] } | undefined;
  if (editorEntry !== undefined && editorEntry.outcome === undefined) {
    editorStatus = {
      text: progressText(editorEntry.progress),
      cancellable: editorEntry.progress.cancellable,
    };
  } else if (editorEntry?.outcome?.kind === 'failed') {
    editorFailure = { message: editorEntry.outcome.message, issues: editorEntry.outcome.issues };
  } else if (editorEntry?.outcome?.kind === 'unknown') {
    editorFailure = { message: UNKNOWN_SAVE, issues: [] };
  }
  // While the open editor's save is on its way, no other editor opens: its result shows here.
  const editorBusy = editorStatus !== undefined;
  const cancelEditor = () => {
    if (editorEntry !== undefined && editorEntry.outcome === undefined) {
      queue?.cancel(editorEntry.id);
      setEditing((current) =>
        current?.entryId === editorEntry.id ? { ...current, notSent: true } : current,
      );
      return;
    }
    if (editorEntry !== undefined) {
      queue?.dismiss(editorEntry.id);
    }
    setEditing(undefined);
  };
  const editProduct = (productId: string) => {
    const item = products?.find((candidate) => candidate.d === productId);
    if (item === undefined || editorBusy) {
      return;
    }
    // Moving to another product leaves the shown failure of this one behind.
    if (editorEntry !== undefined) {
      queue?.dismiss(editorEntry.id);
    }
    openEditor({ mode: 'edit', item });
  };

  const importEntry = pendingEntries.find(
    (entry) => entry.op.kind === 'merge' || entry.op.kind === 'replace',
  );
  let importPending: { text: string; onCancel?: () => void } | undefined;
  if (importEntry !== undefined && queue !== undefined) {
    importPending = {
      text: progressText(importEntry.progress),
      ...(importEntry.progress.cancellable ? { onCancel: () => queue.cancel(importEntry.id) } : {}),
    };
  }

  // The newest: a retry's entry, not the one it replaced.
  // A try counts on the notice only while some of its products are still unreadable: one whose
  // products all read now shows on their rows instead. Any such try on its way comes first
  // (readability can change back), then the newest that ended without going through.
  const noticeShown = products !== undefined && unreadable.length > 0;
  const pendingEntry = unreadableRemovals.find(
    (entry) => entry.outcome === undefined && stillUnreadable(entry),
  );
  const settledEntry = unreadableRemovals.find(
    (entry) => entry.outcome !== undefined && stillUnreadable(entry),
  );
  const failedEntry =
    pendingEntry === undefined &&
    settledEntry !== undefined &&
    (settledEntry.outcome?.kind === 'failed' || settledEntry.outcome?.kind === 'unknown')
      ? settledEntry
      : undefined;
  // The confirmation stays open only for exactly the products it named, while no try holds the
  // notice; once closed it is forgotten, so it never comes back by itself.
  const confirmOpen =
    noticeShown &&
    pendingEntry === undefined &&
    failedEntry === undefined &&
    confirmingUnreadable !== undefined &&
    unreadableToRemove.length > 0 &&
    confirmingUnreadable.length === unreadableToRemove.length &&
    unreadableToRemove.every((d) => confirmingUnreadable.includes(d));
  if (confirmingUnreadable !== undefined && !confirmOpen) {
    setConfirmingUnreadable(undefined);
  }
  let unreadableNotice: ReactNode = null;
  if (noticeShown) {
    let unreadableAction: ReactNode = null;
    if (pendingEntry !== undefined) {
      unreadableAction = <span role="status">{removalText(pendingEntry.progress)}</span>;
    } else if (failedEntry !== undefined) {
      unreadableAction = (
        <span className="flex flex-wrap items-center gap-8">
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            onClick={() => removeUnreadable(failedEntry)}
          >
            Retry
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => queue?.dismiss(failedEntry.id)}
          >
            Dismiss
          </button>
        </span>
      );
    } else if (confirmOpen) {
      unreadableAction = (
        <span className="flex flex-wrap items-center gap-8">
          Remove {plural(unreadableToRemove.length, 'unreadable product')}? They disappear from the
          chat.
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={locked}
            onClick={() => removeUnreadable()}
          >
            Remove
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirmingUnreadable(undefined)}
          >
            Keep
          </button>
        </span>
      );
    } else if (canWrite && unreadableToRemove.length > 0) {
      unreadableAction = (
        <span>
          <button
            type="button"
            className="underline"
            disabled={locked}
            onClick={() => setConfirmingUnreadable(unreadableToRemove)}
          >
            Remove them
          </button>
        </span>
      );
    }
    let unreadableFailure = '';
    if (failedEntry?.outcome?.kind === 'failed') {
      unreadableFailure = failedEntry.outcome.message;
    } else if (failedEntry?.outcome?.kind === 'unknown') {
      unreadableFailure = 'Sent; press Refresh to check.';
    }
    unreadableNotice = (
      <Notice tone="warn">
        <span className="flex flex-col gap-6">
          <span>
            {plural(unreadable.length, 'listed product')} cannot be read right now; they count
            toward your plan.
          </span>
          {unreadableFailure === '' ? null : <span role="alert">{unreadableFailure}</span>}
          {unreadableAction}
        </span>
      </Notice>
    );
  }

  let replaceHint = '';
  if (editing !== undefined) {
    replaceHint = 'Replace all waits until the product editor is closed.';
  } else if (queueBusy) {
    replaceHint = 'Replace all waits until your changes are published.';
  } else if (running) {
    replaceHint = 'Replace all waits until the products being published are done.';
  }

  const currency = config?.currency ?? DEFAULT_CURRENCY;
  const maxProducts = view.tier?.maxProducts;
  const listWait =
    readError === '' ? 'Reading your products...' : 'Your products are not read yet.';

  return (
    <div className="flex flex-col gap-32">
      <NeedsActiveStore
        view={view}
        noun="add products"
        {...(onChoosePlan === undefined ? {} : { onChoosePlan })}
      />
      {readError === '' ? null : (
        <Notice tone="error">
          {readError}{' '}
          <button type="button" className="underline" onClick={() => void read()}>
            Retry
          </button>
        </Notice>
      )}
      {notice === '' ? null : <Notice tone="success">{notice}</Notice>}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {products === undefined || editing === undefined || !active ? null : (
        <ProductEditor
          key={editing.mode === 'edit' ? editing.item.d : 'new'}
          initial={editing.mode === 'edit' ? editing.item : undefined}
          {...(editing.mode === 'new' && editing.draft !== undefined
            ? { draft: editing.draft }
            : {})}
          currency={currency}
          takenIds={takenIds}
          onSave={save}
          onCancel={cancelEditor}
          {...(editorStatus === undefined ? {} : { status: editorStatus })}
          {...(editorFailure === undefined ? {} : { failure: editorFailure })}
          {...(editing.notSent === true && editorStatus === undefined
            ? { note: 'Not sent. Your edits are kept.' }
            : {})}
        />
      )}
      <Section
        title="Catalog"
        info={HELP.catalog}
        description="Saving a product publishes it at once. Removing one deletes it for good; to take one off sale for a while, set its availability to hidden instead."
        actions={
          products === undefined || editing !== undefined || !active ? undefined : (
            <button
              type="button"
              className="btn btn-primary"
              ref={addButton}
              disabled={locked}
              onClick={() => openEditor({ mode: 'new' })}
            >
              Add a product
            </button>
          )
        }
        flush
      >
        <div className="border-line flex items-start justify-between gap-12 border-b px-20 py-12">
          <SyncStatus sync={view.catalogSync} />
          <InfoTip help={HELP.lastPublish} about="Last publish" />
        </div>
        {unreadableNotice === null ? null : (
          <div className="border-line border-b px-20 py-12">{unreadableNotice}</div>
        )}
        {products === undefined ? (
          <p className="text-14 text-text-2 px-20 py-16">{listWait}</p>
        ) : (
          <>
            <ProductList
              items={products}
              onEdit={editProduct}
              onRemove={remove}
              rows={rows}
              lockedIds={lockedIds}
              locked={locked}
              editLocked={editorBusy}
              readOnly={!active}
            />
            <p className="border-line text-12 text-text-3 border-t px-20 py-10">
              {plural(products.length, 'product')}
              {unreadable.length === 0 ? '' : ` (${unreadable.length} unreadable)`}
              {maxProducts === undefined ? '' : ` of ${maxProducts} your plan allows`}. Products set
              to hidden stay listed so you can show them again; removing one deletes it.
            </p>
          </>
        )}
      </Section>

      {products === undefined || !active ? null : (
        <Section
          title="Import from a CSV file"
          info={HELP.csvImport}
          description="Add products from a spreadsheet, or replace all of them. Importing publishes at once."
        >
          <CsvImport
            currency={currency}
            current={products}
            onImport={importFile}
            canReplace={canWrite && !queueBusy && !running && editing === undefined}
            {...(replaceHint === '' ? {} : { replaceHint })}
            prepareReplace={prepareReplace}
            onConfirming={setReplacing}
            onMounted={panelMounted}
            locked={!canWrite || replacePending}
            {...(importPending === undefined ? {} : { pending: importPending })}
          />
        </Section>
      )}
    </div>
  );
}
