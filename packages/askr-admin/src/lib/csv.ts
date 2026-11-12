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

/** One row and the line of the file it starts on (1 = the header). */
export interface CsvRow {
  line: number;
  cells: string[];
}

export interface CsvParse {
  rows: CsvRow[];
  /** The line a quoted field opens on that never closes: nothing after it is read. */
  unclosedQuoteLine?: number;
}

/**
 * RFC 4180 rows: quoted fields, `""` inside quotes, CRLF, LF or CR, a leading
 * BOM dropped, blank lines skipped. Each row keeps the line it starts on, also
 * after quoted cells that span lines.
 */
export function parseCsv(text: string): CsvParse {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  const endRow = () => {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) {
      rows.push({ line: rowLine, cells: row });
    }
    row = [];
    field = '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const lineBreak = char === '\n' || char === '\r';
    if (char === '\r' && source[index + 1] === '\n') {
      index += 1;
    }
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += lineBreak ? '\n' : char;
      }
      if (lineBreak) {
        line += 1;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      quoteLine = line;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (lineBreak) {
      endRow();
      line += 1;
      rowLine = line;
    } else {
      field += char;
    }
  }
  if (quoted) {
    return { rows, unclosedQuoteLine: quoteLine };
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return { rows };
}

/** The server takes a catalog body of at most 8 MiB, so a larger file cannot be one catalog. */
export const MAX_CSV_BYTES = 8 * 1024 * 1024;

/** Why a file of `bytes` is not read, or undefined. */
export function csvSizeProblem(bytes: number): string | undefined {
  return bytes > MAX_CSV_BYTES
    ? 'The file is larger than 8 MB, more than one catalog can hold. Split it or remove columns the import does not read.'
    : undefined;
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
  const result: CsvImport = { items: [], errors: [], fileErrors: [], ignoredColumns: [] };
  const parsedFile = parseCsv(text);
  if (parsedFile.unclosedQuoteLine !== undefined) {
    result.fileErrors.push(
      `The file has an unclosed quote starting at line ${parsedFile.unclosedQuoteLine}, so nothing was read. Close the quote and import it again.`,
    );
    return result;
  }
  const [header, ...rows] = parsedFile.rows;
  if (header === undefined) {
    result.fileErrors.push('The file is empty.');
    return result;
  }
  const names = header.cells.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    result.fileErrors.push(
      `The file has no ${missing.join(', ')} column. The first row must name the columns.`,
    );
    return result;
  }
  result.ignoredColumns = names.filter((name) => name !== '' && !isColumn(name));
  const seen = new Set<string>();
  rows.forEach(({ line, cells: row }) => {
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
