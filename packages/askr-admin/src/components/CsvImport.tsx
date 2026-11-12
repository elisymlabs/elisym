import type { CatalogItemInput } from '@elisym/askr';
import { useState } from 'react';
import {
  CSV_COLUMNS,
  type CsvImport as CsvResult,
  csvSizeProblem,
  productsFromCsv,
} from '../lib/csv';
import { Notice } from './Notice';

interface Props {
  currency: string;
  onImport: (items: CatalogItemInput[], mode: 'merge' | 'replace') => void;
}

const MAX_SHOWN_ERRORS = 50;

/** A CSV file read in the browser, every row checked before anything is kept. */
export function CsvImport({ currency, onImport }: Props) {
  const [result, setResult] = useState<CsvResult>();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [acknowledged, setAcknowledged] = useState(false);

  const read = async (file: File | undefined) => {
    setAcknowledged(false);
    if (file === undefined) {
      setResult(undefined);
      return;
    }
    const tooLarge = csvSizeProblem(file.size);
    setResult(
      tooLarge === undefined
        ? productsFromCsv(await file.text(), currency)
        : { items: [], errors: [], fileErrors: [tooLarge], ignoredColumns: [] },
    );
  };

  return (
    <div className="border-line rounded-12 flex flex-col gap-12 border p-16">
      <h3 className="text-15 font-semibold">Import a CSV file</h3>
      <p className="text-13 text-text-2">
        Columns: {CSV_COLUMNS.join(', ')}. The first row names them; d, title and price are
        required. Put several images or topics in one cell separated by |.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV file"
        onChange={(event) => void read(event.target.files?.[0])}
      />
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
          {mode === 'replace' && result.errors.length > 0 ? (
            <label className="text-14 text-error flex items-center gap-8">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I understand that the {result.errors.length} row
              {result.errors.length === 1 ? '' : 's'} with problems are left out, so those products
              are hidden when I publish.
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
