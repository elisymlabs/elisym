import {
  CSV_COLUMNS,
  CSV_EXAMPLE,
  CSV_VARIANT_COLUMNS,
  type CatalogItemInput,
  type CsvImport as CsvResult,
  csvSizeProblem,
  productsFromCsv,
} from '@elisym/askr';
import { useEffect, useRef, useState } from 'react';
import { type Outcome, Pause } from '../lib/catalog-writer';
import { Notice } from './Notice';

/** Before a replace: a running sync waited out and the catalog read fresh. */
export type ReplacePrepared =
  | { kind: 'ready'; hidden: number }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

interface Props {
  currency: string;
  /** The products now listed: an import warns before replacing a richer one whole. */
  current: readonly CatalogItemInput[];
  /** Publishes the file's products at once, added to the current ones or replacing them all. */
  onImport: (items: CatalogItemInput[], mode: 'merge' | 'replace') => Promise<Outcome>;
  /** Replace all may start: no write queued, no sync running, no product editor open. */
  canReplace?: boolean;
  /**
   * Wait out a running sync and read the catalog fresh: how many products the
   * file would remove. Without it the count is worked out from `current`.
   */
  prepareReplace?: (items: CatalogItemInput[], pause: Pause) => Promise<ReplacePrepared>;
  /** The replace confirmation opened or closed: nothing else may change the count meanwhile. */
  onConfirming?: (open: boolean) => void;
  /** Import is off: another action holds the list. */
  locked?: boolean;
  /** The queued import on its way, with Cancel while nothing is in flight. */
  pending?: { text: string; onCancel?: () => void };
  /** Why Replace all is off right now. */
  replaceHint?: string;
  /** Told when this panel mounts and unmounts: an import it started reports here only then. */
  onMounted?: (mounted: boolean) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'confirming'; hidden: number }
  | { kind: 'sending'; mode: 'merge' | 'replace' };

const MAX_SHOWN_ERRORS = 50;
/** Fields a file's product may lack while the current one has them: lost on a merge. */
const LIST_FIELDS = ['variants', 'options', 'attrs', 'topics', 'images'] as const;
const TEXT_FIELDS = ['summary', 'description', 'url', 'sku'] as const;
const EXAMPLE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_EXAMPLE)}`;

function productCount(count: number): string {
  return `${count} product${count === 1 ? '' : 's'}`;
}

/** Products of `current` the file does not hold: a replace removes them. */
function removedBy(
  current: readonly CatalogItemInput[],
  items: readonly CatalogItemInput[],
): number {
  const kept = new Set(items.map((item) => item.d));
  return current.filter((item) => !kept.has(item.d)).length;
}

/** A CSV file read in the browser, every row checked before anything is published. */
export function CsvImport({
  currency,
  current,
  onImport,
  canReplace = true,
  prepareReplace,
  onConfirming,
  locked = false,
  pending,
  replaceHint,
  onMounted,
}: Props) {
  const [result, setResult] = useState<CsvResult>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  /** Counts file choices: a slow read of an earlier file never replaces a newer one's result. */
  const choice = useRef(0);
  /** The wait before a replace's confirmation, ended by Cancel or an unmount. */
  const preparing = useRef<Pause | undefined>(undefined);
  useEffect(() => () => preparing.current?.stop(), []);
  useEffect(() => {
    onMounted?.(true);
    return () => onMounted?.(false);
  }, [onMounted]);
  // From the wait before the question to its answer, nothing else may change the count.
  const confirming = phase.kind === 'confirming' || phase.kind === 'preparing';
  useEffect(() => {
    onConfirming?.(confirming);
    return () => onConfirming?.(false);
  }, [confirming, onConfirming]);

  const read = async (file: File | undefined) => {
    choice.current += 1;
    const mine = choice.current;
    setError('');
    if (file === undefined) {
      setResult(undefined);
      return;
    }
    const tooLarge = csvSizeProblem(file.size);
    const next =
      tooLarge === undefined
        ? productsFromCsv(await file.text(), currency)
        : { items: [], errors: [], fileErrors: [tooLarge], ignoredColumns: [] };
    if (mine === choice.current) {
      setResult(next);
    }
  };

  // A file's product replaces the current one whole: say so when the current one has
  // something the file's lacks, came from a connector, or its availability changes.
  const richer =
    result === undefined
      ? []
      : result.items.filter((item) =>
          current.some(
            (existing) =>
              existing.d === item.d &&
              (LIST_FIELDS.some(
                (field) => (existing[field]?.length ?? 0) > 0 && (item[field]?.length ?? 0) === 0,
              ) ||
                TEXT_FIELDS.some(
                  (field) => (existing[field] ?? '') !== '' && (item[field] ?? '') === '',
                ) ||
                existing.sourceId !== undefined ||
                (existing.visibility ?? 'on-sale') !== (item.visibility ?? 'on-sale')),
          ),
        );

  const reset = () => {
    setResult(undefined);
    setPhase({ kind: 'idle' });
    // The same file can be chosen again.
    if (fileInput.current !== null) {
      fileInput.current.value = '';
    }
  };

  const send = async (items: CatalogItemInput[], mode: 'merge' | 'replace') => {
    setError('');
    setPhase({ kind: 'sending', mode });
    const outcome = await onImport(items, mode);
    if (outcome.kind === 'ok') {
      reset();
    } else if (outcome.kind === 'recount') {
      setPhase({ kind: 'confirming', hidden: outcome.hidden });
    } else if (outcome.kind === 'failed') {
      setPhase({ kind: 'idle' });
      setError(outcome.message);
    } else if (outcome.kind === 'unknown') {
      setPhase({ kind: 'idle' });
      setError('Sent; its result could not be read. Press Refresh to check.');
    } else {
      setPhase({ kind: 'idle' });
    }
  };

  const startReplace = async (items: CatalogItemInput[]) => {
    setError('');
    if (prepareReplace === undefined) {
      setPhase({ kind: 'confirming', hidden: removedBy(current, items) });
      return;
    }
    const pause = new Pause();
    preparing.current = pause;
    setPhase({ kind: 'preparing' });
    const prepared = await prepareReplace(items, pause);
    if (preparing.current === pause) {
      preparing.current = undefined;
    }
    if (prepared.kind === 'ready') {
      setPhase({ kind: 'confirming', hidden: prepared.hidden });
    } else {
      setPhase({ kind: 'idle' });
      setError(prepared.kind === 'failed' ? prepared.message : '');
    }
  };

  const busy = phase.kind !== 'idle' || pending !== undefined;

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center gap-12">
        <input
          type="file"
          ref={fileInput}
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="text-13 text-text-2 file:border-line-2 file:bg-surface file:text-13 file:text-text hover:file:bg-surface-2 file:rounded-8 min-w-0 file:mr-12 file:cursor-pointer file:border file:px-12 file:py-6 file:font-medium"
          disabled={busy || locked}
          onChange={(event) => void read(event.target.files?.[0])}
        />
        <a
          className="text-13 text-text-2 hover:text-text underline underline-offset-2"
          href={EXAMPLE_HREF}
          download="askr-products-example.csv"
        >
          Download an example file
        </a>
      </div>
      <details className="disclosure text-13 text-text-2">
        <summary className="text-text">File format</summary>
        <div className="mt-8 flex flex-col gap-6 pl-16 leading-relaxed">
          <p>
            Columns: {CSV_COLUMNS.join(', ')}. The first row names them; d, title and price are
            required. Put several images or topics in one cell separated by |. frequency is hour,
            day, week, month or year for a subscription.
          </p>
          <p>
            Attributes: a column named attr:Material (any name after attr:) gives every product that
            fills it that attribute.
          </p>
          <p>
            Sizes, colors and other variants: name a column per option, such as option:Size and
            option:Color, plus {CSV_VARIANT_COLUMNS.join(', ')} if you need them. Each variant is
            one row with the same d; the product&apos;s other columns go on its first row only,
            which may itself be a variant or carry no option values. An empty variant_price is the
            product&apos;s price, variant_available is yes or no (yes when empty), * in an option
            cell means any value of that option, and the listing shows the lowest in-stock variant
            price.
          </p>
        </div>
      </details>
      {pending === undefined ? null : (
        <p className="text-14 text-text-2 flex flex-wrap items-center gap-8" role="status">
          {pending.text}
          {pending.onCancel === undefined ? null : (
            <button type="button" className="btn btn-sm" onClick={pending.onCancel}>
              Cancel
            </button>
          )}
        </p>
      )}
      {result === undefined ? null : (
        <div className="flex flex-col gap-8">
          {result.fileErrors.map((message) => (
            <Notice key={message} tone="error">
              {message}
            </Notice>
          ))}
          {result.fileErrors.length > 0 ? null : (
            <p className="text-14">
              {result.items.length} product{result.items.length === 1 ? '' : 's'} read,{' '}
              {result.errors.length} row{result.errors.length === 1 ? '' : 's'} with problems.
            </p>
          )}
          {result.ignoredColumns.length === 0 ? null : (
            <p className="text-13 text-text-2">
              Ignored columns: {result.ignoredColumns.join(', ')}
            </p>
          )}
          {result.errors.length === 0 ? null : (
            <Notice tone="error">
              <ul className="flex flex-col gap-2">
                {result.errors.slice(0, MAX_SHOWN_ERRORS).map((rowError) => (
                  <li key={rowError.line}>
                    Line {rowError.line}: {rowError.messages.join('; ')}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {richer.length > 0 ? (
            <Notice tone="warn">
              {richer.length} row
              {richer.length === 1 ? ' replaces a product' : 's replace products'} whose variants,
              options, attributes, topics, images, texts, link, SKU, connector origin or
              availability the file does not carry, and those are lost:{' '}
              {richer.map((item) => item.d).join(', ')}.
            </Notice>
          ) : null}
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          {phase.kind === 'confirming' ? (
            <Notice tone="warn">
              <span className="flex flex-col gap-8">
                <span>
                  Replace all products? {phase.hidden} product{phase.hidden === 1 ? '' : 's'} not in
                  this file will be removed from the chat.
                  {result.errors.length > 0
                    ? ` ${result.errors.length} row${result.errors.length === 1 ? '' : 's'} with problems ${result.errors.length === 1 ? 'is' : 'are'} left out.`
                    : ''}
                </span>
                <span className="flex flex-wrap gap-8">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!canReplace}
                    onClick={() => void send(result.items, 'replace')}
                  >
                    Replace all
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setPhase({ kind: 'idle' })}
                  >
                    Keep my products
                  </button>
                </span>
              </span>
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-8">
            <button
              type="button"
              className="btn btn-primary"
              disabled={result.items.length === 0 || busy || locked}
              onClick={() => void send(result.items, 'merge')}
            >
              {phase.kind === 'sending' && phase.mode === 'merge'
                ? 'Importing...'
                : `Import ${productCount(result.items.length)}`}
            </button>
            {phase.kind === 'preparing' ? (
              <>
                <button type="button" className="btn" disabled>
                  Waiting for the running sync
                </button>
                <button type="button" className="btn" onClick={() => preparing.current?.stop()}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={result.items.length === 0 || busy || locked || !canReplace}
                onClick={() => void startReplace(result.items)}
              >
                {phase.kind === 'sending' && phase.mode === 'replace'
                  ? 'Replacing...'
                  : `Replace all with ${productCount(result.items.length)}`}
              </button>
            )}
          </div>
          {replaceHint === undefined ||
          phase.kind !== 'idle' ||
          result.items.length === 0 ? null : (
            <p className="text-13 text-text-2">{replaceHint}</p>
          )}
        </div>
      )}
    </div>
  );
}
