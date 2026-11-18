import type { CatalogItemInput } from '@elisym/askr';
import { useRef, useState } from 'react';
import {
  CSV_COLUMNS,
  CSV_EXAMPLE,
  CSV_VARIANT_COLUMNS,
  type CsvImport as CsvResult,
  csvSizeProblem,
  productsFromCsv,
} from '../lib/csv';
import { Notice } from './Notice';

interface Props {
  currency: string;
  /** The products now in the draft: a merge warns before replacing a richer one whole. */
  current: readonly CatalogItemInput[];
  onImport: (items: CatalogItemInput[], mode: 'merge' | 'replace') => void;
}

const MAX_SHOWN_ERRORS = 50;
/** Fields a file's product may lack while the current one has them: lost on a merge. */
const LIST_FIELDS = ['variants', 'options', 'attrs', 'topics', 'images'] as const;
const TEXT_FIELDS = ['summary', 'description', 'url', 'sku'] as const;
const EXAMPLE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_EXAMPLE)}`;

/** A CSV file read in the browser, every row checked before anything is kept. */
export function CsvImport({ currency, current, onImport }: Props) {
  const [result, setResult] = useState<CsvResult>();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [acknowledged, setAcknowledged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Counts file choices: a slow read of an earlier file never replaces a newer one's result. */
  const choice = useRef(0);

  const read = async (file: File | undefined) => {
    choice.current += 1;
    const mine = choice.current;
    setAcknowledged(false);
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

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center gap-12">
        <input
          type="file"
          ref={fileInput}
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="text-13 text-text-2 file:border-line-2 file:bg-surface file:text-13 file:text-text hover:file:bg-surface-2 file:rounded-8 min-w-0 file:mr-12 file:cursor-pointer file:border file:px-12 file:py-6 file:font-medium"
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
          <fieldset className="text-14 flex flex-col gap-4">
            <label className="flex items-center gap-8">
              <input
                type="radio"
                name="csv-mode"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
              />
              Add to my products (a row with an existing ID replaces that product)
            </label>
            <label className="flex items-center gap-8">
              <input
                type="radio"
                name="csv-mode"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              />
              Replace all my products with this file
            </label>
          </fieldset>
          {mode === 'merge' && richer.length > 0 ? (
            <Notice tone="warn">
              {richer.length} row
              {richer.length === 1 ? ' replaces a product' : 's replace products'} whose variants,
              options, attributes, topics, images, texts, link, SKU, connector origin or
              availability the file does not carry, and those are lost:{' '}
              {richer.map((item) => item.d).join(', ')}.
            </Notice>
          ) : null}
          {mode === 'replace' && result.errors.length > 0 ? (
            <label className="text-14 text-error flex items-center gap-8">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I understand that the {result.errors.length} row
              {result.errors.length === 1 ? '' : 's'} with problems are left out, so those products
              are removed for good when I publish.
            </label>
          ) : null}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                result.items.length === 0 ||
                (mode === 'replace' && result.errors.length > 0 && !acknowledged)
              }
              onClick={() => {
                onImport(result.items, mode);
                setResult(undefined);
                // The same file can be chosen again.
                if (fileInput.current !== null) {
                  fileInput.current.value = '';
                }
              }}
            >
              Use these {result.items.length} products
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
