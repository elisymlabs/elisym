import { type CatalogItemInput, CatalogItemInputSchema } from '@elisym/askr';

/** Columns the import reads; `d`, `title` and `price` are required. */
export const CSV_COLUMNS = [
  'd',
  'title',
  'price',
  'currency',
  'summary',
  'description',
  'url',
  'image',
  'visibility',
  'topics',
  'sku',
] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];
const REQUIRED_COLUMNS: readonly CsvColumn[] = ['d', 'title', 'price'];
/** Several images or topics in one cell. */
const LIST_SEPARATOR = '|';

export interface CsvRowError {
  /** The line of the row in the file, counting the header as line 1. */
  line: number;
  messages: string[];
}

export interface CsvImport {
  items: CatalogItemInput[];
  errors: CsvRowError[];
  /** Problems with the file as a whole (a missing column); no rows are read then. */
  fileErrors: string[];
  /** Header names the import does not read. */
  ignoredColumns: string[];
}

/** RFC 4180 rows: quoted fields, `""` inside quotes, CRLF or LF, a leading BOM dropped. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function isColumn(name: string): name is CsvColumn {
  return CSV_COLUMNS.some((column) => column === name);
}

function listOf(cell: string): string[] {
  return cell
    .split(LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** One row as the catalog API takes it; empty cells are left out. */
function itemOfRow(
  cells: ReadonlyMap<CsvColumn, string>,
  defaultCurrency: string,
): Record<string, unknown> {
  const cell = (column: CsvColumn) => cells.get(column)?.trim() ?? '';
  const item: Record<string, unknown> = {
    d: cell('d'),
    title: cell('title'),
    price: { amount: cell('price'), currency: (cell('currency') || defaultCurrency).toUpperCase() },
  };
  const description = cells.get('description') ?? '';
  if (description.trim() !== '') {
    item.description = description;
  }
  for (const column of ['summary', 'url', 'visibility', 'sku'] as const) {
    if (cell(column) !== '') {
      item[column] = cell(column);
    }
  }
  if (cell('image') !== '') {
    item.images = listOf(cell('image'));
  }
  if (cell('topics') !== '') {
    item.topics = listOf(cell('topics'));
  }
  return item;
}

/**
 * Products from a CSV file, each row checked with the same schema the server
 * uses. A row with any problem is left out and reported with its line.
 */
export function productsFromCsv(text: string, defaultCurrency: string): CsvImport {
  const [header, ...rows] = parseCsv(text);
  const result: CsvImport = { items: [], errors: [], fileErrors: [], ignoredColumns: [] };
  if (header === undefined) {
    result.fileErrors.push('The file is empty.');
    return result;
  }
  const names = header.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    result.fileErrors.push(
      `The file has no ${missing.join(', ')} column. The first row must name the columns.`,
    );
    return result;
  }
  result.ignoredColumns = names.filter((name) => name !== '' && !isColumn(name));
  const seen = new Set<string>();
  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 2;
    const cells = new Map<CsvColumn, string>();
    names.forEach((name, columnIndex) => {
      if (isColumn(name)) {
        cells.set(name, row[columnIndex] ?? '');
      }
    });
    const parsed = CatalogItemInputSchema.safeParse(itemOfRow(cells, defaultCurrency));
    const messages = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`);
    const d = cells.get('d')?.trim() ?? '';
    if (d !== '' && seen.has(d)) {
      messages.push(`d: "${d}" is used by an earlier row`);
    }
    seen.add(d);
    if (messages.length > 0 || !parsed.success) {
      result.errors.push({ line, messages });
      return;
    }
    result.items.push(parsed.data);
  });
  return result;
}
