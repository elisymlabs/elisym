/**
 * The products CSV import (A11): merge only, upsert by `d`. The whole file is
 * read and every row checked with the shared product rules before the first
 * write; then each row is a `PUT products/:d`, one after the other, and the
 * first refusal (the plan's cap, `product_cap`, above all) stops the run.
 */
import { ApiError } from './api';
import { type ProductField, type ProductProblems, checkProduct } from './product-fields';
import type { ProductInput } from './types';

export const CSV_COLUMNS = [
  'd',
  'title',
  'priceUsd',
  'onSale',
  'summary',
  'url',
  'description',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

const REQUIRED_COLUMNS: readonly CsvColumn[] = ['d', 'title', 'priceUsd'];

/** The largest file read, in bytes: far above any plan's products, well below a tab's memory. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
/** The most product rows one file may hold. */
export const MAX_CSV_ROWS = 1000;

export const CSV_TOO_LARGE = 'The file is larger than 2 MB. Split it and import each part.';
export const CSV_TOO_MANY_ROWS =
  'The file has more than 1000 products. Split it and import each part.';
export const CSV_UNREADABLE =
  'The file is not valid CSV: check its quotes (a quoted cell starts and ends with ", and a " inside it is written "").';
export const CSV_EMPTY = 'The file has no products: a header line and one product line at least.';
export const CSV_BAD_HEADER =
  'The first line must name the columns: d, title and priceUsd, and optionally onSale, summary, url and description, each once.';
export const CSV_ROW_WIDTH = 'This line has a different number of cells than the header.';
export const CSV_ON_SALE = 'onSale is true, false, or empty (on sale).';
export const CSV_DUPLICATE_D = 'This product id is already on an earlier line.';

const BOM = '﻿';

export interface CsvRow {
  /** The line the row starts on, 1 being the header. */
  line: number;
  d: string;
  input: ProductInput;
}

export interface CsvProblem {
  /** Undefined for a problem with the whole file. */
  line: number | undefined;
  text: string;
}

export type CsvCheck = { ok: true; rows: CsvRow[] } | { ok: false; problems: CsvProblem[] };

export interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * RFC 4180 records: cells split by commas, lines by CRLF or LF; a quoted cell
 * may hold commas, line breaks and `""` for a quote. A quote inside an
 * unquoted cell, text after a closing quote, or a quote left open is refused.
 * A lone CR at the very end of the file ends the last line.
 * Blank lines are skipped.
 */
export function parseCsv(text: string): CsvRecord[] | undefined {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.length > 1 || cells[0] !== '') {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    cell = '';
    afterQuote = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (char === '\n') {
          line += 1;
        }
        cell += char;
      }
      continue;
    }
    if (char === ',') {
      cells.push(cell);
      cell = '';
      afterQuote = false;
    } else if (
      char === '\n' ||
      (char === '\r' && (source[index + 1] === '\n' || index + 1 === source.length))
    ) {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      endRecord();
      line += 1;
      recordLine = line;
    } else if (afterQuote) {
      return undefined;
    } else if (char === '"') {
      if (cell !== '') {
        return undefined;
      }
      quoted = true;
    } else {
      cell += char;
    }
  }
  if (quoted) {
    return undefined;
  }
  endRecord();
  return records;
}

function columnOf(name: string): CsvColumn | undefined {
  return CSV_COLUMNS.find((column) => column === name);
}

/** Where each column sits, or undefined for a header that is not exactly the known columns. */
function readHeader(cells: readonly string[]): Map<CsvColumn, number> | undefined {
  const positions = new Map<CsvColumn, number>();
  for (const [index, name] of cells.entries()) {
    const column = columnOf(name.trim());
    if (column === undefined || positions.has(column)) {
      return undefined;
    }
    positions.set(column, index);
  }
  return REQUIRED_COLUMNS.every((column) => positions.has(column)) ? positions : undefined;
}

function readOnSale(value: string): boolean | undefined {
  const lowered = value.trim().toLowerCase();
  if (lowered === '' || lowered === 'true') {
    return true;
  }
  return lowered === 'false' ? false : undefined;
}

const FIELD_ORDER: readonly ProductField[] = [
  'd',
  'title',
  'priceUsd',
  'summary',
  'url',
  'description',
];

function problemTexts(problems: ProductProblems): string[] {
  return FIELD_ORDER.flatMap((field) => {
    const text = problems[field];
    return text === undefined ? [] : [`${field}: ${text}`];
  });
}

/** The file, every row checked: the rows to send, or every problem found (nothing is sent then). */
export function checkProductsCsv(text: string): CsvCheck {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    return { ok: false, problems: [{ line: undefined, text: CSV_TOO_LARGE }] };
  }
  const records = parseCsv(text);
  if (records === undefined) {
    return { ok: false, problems: [{ line: undefined, text: CSV_UNREADABLE }] };
  }
  const [header, ...body] = records;
  if (header === undefined || body.length === 0) {
    return { ok: false, problems: [{ line: undefined, text: CSV_EMPTY }] };
  }
  const positions = readHeader(header.cells);
  if (positions === undefined) {
    return { ok: false, problems: [{ line: header.line, text: CSV_BAD_HEADER }] };
  }
  if (body.length > MAX_CSV_ROWS) {
    return { ok: false, problems: [{ line: undefined, text: CSV_TOO_MANY_ROWS }] };
  }
  const rows: CsvRow[] = [];
  const problems: CsvProblem[] = [];
  const seen = new Set<string>();
  for (const record of body) {
    if (record.cells.length !== header.cells.length) {
      problems.push({ line: record.line, text: CSV_ROW_WIDTH });
      continue;
    }
    const cellOf = (column: CsvColumn) => {
      const index = positions.get(column);
      return index === undefined ? '' : (record.cells[index] ?? '');
    };
    const onSale = readOnSale(cellOf('onSale'));
    const checked = checkProduct({
      d: cellOf('d'),
      title: cellOf('title'),
      priceUsd: cellOf('priceUsd'),
      summary: cellOf('summary'),
      url: cellOf('url'),
      description: cellOf('description'),
      onSale: onSale ?? true,
    });
    const texts = checked.ok ? [] : problemTexts(checked.problems);
    if (onSale === undefined) {
      texts.push(`onSale: ${CSV_ON_SALE}`);
    }
    const d = cellOf('d').trim();
    if (d !== '' && seen.has(d)) {
      texts.push(`d: ${CSV_DUPLICATE_D}`);
    }
    seen.add(d);
    if (texts.length > 0) {
      problems.push(...texts.map((problem) => ({ line: record.line, text: problem })));
    } else if (checked.ok) {
      rows.push({ line: record.line, d: checked.d, input: checked.input });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows };
}

export type ImportOutcome =
  | { done: true; written: number }
  | { done: false; aborted: true; written: number }
  | { done: false; written: number; failed: CsvRow; error: unknown };

/** Each row in turn; the first refusal stops the run, and the outcome says how far it got. */
export async function importProducts(
  rows: readonly CsvRow[],
  putProduct: (d: string, input: ProductInput) => Promise<unknown>,
  onWritten?: (written: number) => void,
  /** Checked before each row: once aborted, no further row is sent. */
  signal?: AbortSignal,
): Promise<ImportOutcome> {
  let written = 0;
  for (const row of rows) {
    if (signal?.aborted === true) {
      return { done: false, aborted: true, written };
    }
    try {
      await putProduct(row.d, row.input);
    } catch (error) {
      return { done: false, written, failed: row, error };
    }
    written += 1;
    onWritten?.(written);
  }
  return { done: true, written };
}

/** Whether a stopped run was stopped by the plan's cap. */
export function isCapRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'product_cap';
}
