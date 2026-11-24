import { type ReactNode, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import {
  CSV_COLUMNS,
  CSV_TOO_LARGE,
  type CsvProblem,
  type CsvRow,
  MAX_CSV_BYTES,
  checkProductsCsv,
  importProducts,
  isCapRefusal,
} from '../lib/products-csv';
import type { StoreSession } from '../lib/store-session';
import { BUTTON_SECONDARY, BUTTON_TEXT } from '../styles';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  /** Whether another product change runs: one change at a time. */
  locked: boolean;
  onBusy: (busy: boolean) => void;
  /** Rows were written (all, or some before a refusal): the list is read again. */
  onImported: () => void;
}

export const CSV_UNREADABLE_FILE = 'The file could not be read. Choose it again.';
export const CSV_NOTHING_SENT = 'Nothing was imported. Fix these lines and choose the file again:';
export const CAP_STOP =
  'Your store has as many products on sale as its plan allows, so the import stopped there.';

type Stage =
  | { kind: 'idle' }
  | { kind: 'problems'; problems: CsvProblem[] }
  | { kind: 'ready'; rows: CsvRow[] }
  | { kind: 'running'; rows: CsvRow[]; written: number }
  | { kind: 'done'; written: number }
  | { kind: 'stopped'; written: number; total: number; failed: CsvRow; reason: string };

function problemLine(problem: CsvProblem): string {
  return problem.line === undefined ? problem.text : `Line ${problem.line}: ${problem.text}`;
}

/** Merge products from a CSV file (A11): every line checked first, then written one by one. */
export function CsvImport({ session, locked, onBusy, onImported }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [inputKey, setInputKey] = useState(0);
  const running = useRef<AbortController | undefined>(undefined);

  // Leaving the tab stops the run between rows: nothing more is sent, and nothing is shown.
  useEffect(() => () => running.current?.abort(), []);

  const choose = async (file: File | undefined) => {
    if (file === undefined) {
      setStage({ kind: 'idle' });
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setStage({ kind: 'problems', problems: [{ line: undefined, text: CSV_TOO_LARGE }] });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setStage({ kind: 'problems', problems: [{ line: undefined, text: CSV_UNREADABLE_FILE }] });
      return;
    }
    const checked = checkProductsCsv(text);
    setStage(
      checked.ok
        ? { kind: 'ready', rows: checked.rows }
        : { kind: 'problems', problems: checked.problems },
    );
  };

  const run = async (rows: CsvRow[]) => {
    const controller = new AbortController();
    running.current = controller;
    setStage({ kind: 'running', rows, written: 0 });
    onBusy(true);
    const outcome = await importProducts(
      rows,
      (d, input) => session.api.putProduct(d, input),
      (written) => {
        if (!controller.signal.aborted) {
          setStage({ kind: 'running', rows, written });
        }
      },
      controller.signal,
    );
    if (controller.signal.aborted) {
      return;
    }
    running.current = undefined;
    onBusy(false);
    setInputKey((key) => key + 1);
    if (outcome.done) {
      setStage({ kind: 'done', written: outcome.written });
    } else if ('failed' in outcome) {
      setStage({
        kind: 'stopped',
        written: outcome.written,
        total: rows.length,
        failed: outcome.failed,
        reason: isCapRefusal(outcome.error) ? CAP_STOP : errorMessage(outcome.error),
      });
    }
    if (outcome.written > 0) {
      onImported();
    }
  };

  let status: ReactNode = null;
  if (stage.kind === 'problems') {
    status = (
      <div role="alert" className="bg-error-bg text-error rounded-10 text-13 px-12 py-10">
        <p>{CSV_NOTHING_SENT}</p>
        <ul id="csv-problems" className="mt-6 list-disc pl-18">
          {stage.problems.map((problem, index) => (
            <li key={`${problem.line ?? 0}-${index}`}>{problemLine(problem)}</li>
          ))}
        </ul>
      </div>
    );
  } else if (stage.kind === 'ready') {
    const rows = stage.rows;
    status = (
      <div className="flex flex-col gap-8">
        <Notice tone="info">
          {rows.length === 1 ? '1 product is' : `${rows.length} products are`} ready. A product
          whose id is already in your store is replaced by its line; the others stay as they are.
        </Notice>
        <div className="flex items-center gap-12">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={locked}
            onClick={() => void run(rows)}
          >
            Import products
          </button>
          <button
            type="button"
            className={BUTTON_TEXT}
            onClick={() => {
              setStage({ kind: 'idle' });
              setInputKey((key) => key + 1);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (stage.kind === 'running') {
    status = (
      <Notice tone="info">
        Importing: {stage.written} of {stage.rows.length} written.
      </Notice>
    );
  } else if (stage.kind === 'done') {
    status = (
      <Notice tone="info">
        Imported {stage.written === 1 ? '1 product' : `${stage.written} products`}.
      </Notice>
    );
  } else if (stage.kind === 'stopped') {
    status = (
      <Notice tone="error">
        Imported {stage.written} of {stage.total}. Line {stage.failed.line} ({stage.failed.d}) was
        not saved: {stage.reason} Lines after it were not sent.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <h3 className="text-15 font-semibold">Import from CSV</h3>
      <p className="text-13 text-text-2">
        Columns: <span className="font-mono">{CSV_COLUMNS.join(',')}</span>. The first line names
        them; d, title and priceUsd are required. onSale is true, false or empty (on sale). Products
        not in the file are kept.
      </p>
      <input
        key={inputKey}
        id="csv-file"
        type="file"
        accept=".csv,text/csv"
        className="text-13"
        disabled={locked || stage.kind === 'running'}
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      {status}
    </div>
  );
}
