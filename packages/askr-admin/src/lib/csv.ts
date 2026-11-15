import { type CatalogItemInput, CatalogItemInputSchema } from '@elisym/askr';
import { type VariantInput, listingPriceOf } from './variants';

/** Product columns the import reads; `d`, `title` and `price` are required. */
export const CSV_COLUMNS = [
  'd',
  'title',
  'price',
  'currency',
  'frequency',
  'summary',
  'description',
  'url',
  'image',
  'visibility',
  'topics',
  'sku',
] as const;
/** Variant columns: one row per variant, the product's later rows carry only these and `d`. */
export const CSV_VARIANT_COLUMNS = ['variant_id', 'variant_price', 'variant_available'] as const;
/** `attr:Material` is an attribute named Material; `option:Size` an option named Size. */
export const CSV_ATTR_PREFIX = 'attr:';
export const CSV_OPTION_PREFIX = 'option:';
/** A small file that shows every column: a plain product, then one with two options. */
export const CSV_EXAMPLE = [
  'd,title,price,currency,frequency,summary,description,url,image,visibility,topics,sku,attr:Material,option:Size,option:Color,variant_id,variant_price,variant_available',
  'mug-1,Stoneware mug,12.50,USD,,Holds 350 ml,A heavy mug for hot drinks.,https://shop.example/mug,https://shop.example/mug.jpg,on-sale,kitchen|gifts,MUG-1,Stoneware,,,,,',
  'tee-1,Cotton tee,20,USD,,,Soft everyday tee.,https://shop.example/tee,https://shop.example/tee.jpg,,clothing,TEE-1,Cotton,S,Black,tee-s-black,20,yes',
  'tee-1,,,,,,,,,,,,,M,Black,tee-m-black,20,yes',
  'tee-1,,,,,,,,,,,,,L,Black,tee-l-black,22,no',
  'box-1,Coffee subscription,15,USD,month,,A bag of fresh coffee every month.,,,,coffee,BOX-1,,,,,,',
].join('\n');
type CsvColumn = (typeof CSV_COLUMNS)[number];
type CsvVariantColumn = (typeof CSV_VARIANT_COLUMNS)[number];
const REQUIRED_COLUMNS: readonly CsvColumn[] = ['d', 'title', 'price'];
/** Several images or topics in one cell. */
const LIST_SEPARATOR = '|';
const AVAILABLE_WORDS = new Set(['', 'yes', 'y', 'true', '1']);
const UNAVAILABLE_WORDS = new Set(['no', 'n', 'false', '0']);

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

function isVariantColumn(name: string): name is CsvVariantColumn {
  return CSV_VARIANT_COLUMNS.some((column) => column === name);
}

function listOf(cell: string): string[] {
  return cell
    .split(LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** What each header cell is: a product column, a variant column, an attribute or an option. */
type HeaderCell =
  | { kind: 'product'; column: CsvColumn }
  | { kind: 'variant'; column: CsvVariantColumn }
  | { kind: 'attr'; name: string }
  | { kind: 'option'; name: string }
  | { kind: 'ignored'; name: string };

function headerCellOf(raw: string): HeaderCell {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (isColumn(lower)) {
    return { kind: 'product', column: lower };
  }
  if (isVariantColumn(lower)) {
    return { kind: 'variant', column: lower };
  }
  for (const [prefix, kind] of [
    [CSV_ATTR_PREFIX, 'attr'],
    [CSV_OPTION_PREFIX, 'option'],
  ] as const) {
    const name = trimmed.slice(prefix.length).trim();
    if (lower.startsWith(prefix) && name !== '') {
      return { kind, name };
    }
  }
  return { kind: 'ignored', name: trimmed };
}

/** One row's cells by meaning. */
interface RowCells {
  line: number;
  product: Map<CsvColumn, string>;
  variant: Map<CsvVariantColumn, string>;
  attrs: { name: string; value: string }[];
  /** Option name to this row's value, in header order. */
  options: { name: string; value: string }[];
}

function rowCellsOf(line: number, row: readonly string[], header: readonly HeaderCell[]): RowCells {
  const cells: RowCells = { line, product: new Map(), variant: new Map(), attrs: [], options: [] };
  header.forEach((cell, columnIndex) => {
    const value = row[columnIndex] ?? '';
    if (cell.kind === 'product') {
      cells.product.set(cell.column, value);
    } else if (cell.kind === 'variant') {
      cells.variant.set(cell.column, value.trim());
    } else if (cell.kind === 'attr') {
      cells.attrs.push({ name: cell.name, value: value.trim() });
    } else if (cell.kind === 'option') {
      cells.options.push({ name: cell.name, value: value.trim() });
    }
  });
  return cells;
}

/** A row describes a variant when any option or variant cell is filled. */
function hasVariantCells(cells: RowCells): boolean {
  return (
    cells.options.some((option) => option.value !== '') ||
    [...cells.variant.values()].some((value) => value !== '')
  );
}

/** A later row of a product may fill only `d`, the option and the variant cells. */
function hasProductCells(cells: RowCells): boolean {
  return (
    [...cells.product.entries()].some(([column, value]) => column !== 'd' && value.trim() !== '') ||
    cells.attrs.some((attr) => attr.value !== '')
  );
}

/** One product's rows: the first carries the product, every row with variant cells a variant. */
interface ProductRows {
  first: RowCells;
  variantRows: RowCells[];
  /** Problems with single rows, by line. */
  rowErrors: CsvRowError[];
}

/**
 * The product's variants from its rows: an option is used when any row fills
 * it, each variant needs a value for every used option, a missing variant
 * price is the product's price and a missing id the row's number among them.
 */
function variantsOf(group: ProductRows): {
  options: { name: string; values: string[] }[];
  variants: VariantInput[];
} {
  const usedNames = group.first.options
    .map((option) => option.name)
    .filter((name) =>
      group.variantRows.some((row) =>
        row.options.some((option) => option.name === name && option.value !== ''),
      ),
    );
  const options: { name: string; values: string[] }[] = usedNames.map((name) => ({
    name,
    values: [],
  }));
  const fallbackPrice = group.first.product.get('price')?.trim() ?? '';
  const variants: VariantInput[] = [];
  group.variantRows.forEach((row, rowIndex) => {
    const messages: string[] = [];
    const values = options.map((option) => {
      const value = row.options.find((cell) => cell.name === option.name)?.value ?? '';
      if (value === '') {
        messages.push(`option:${option.name}: this variant needs a value`);
      } else if (!option.values.includes(value)) {
        option.values.push(value);
      }
      return value;
    });
    const availableWord = (row.variant.get('variant_available') ?? '').toLowerCase();
    if (!AVAILABLE_WORDS.has(availableWord) && !UNAVAILABLE_WORDS.has(availableWord)) {
      messages.push('variant_available: write yes or no');
    }
    if (messages.length > 0) {
      group.rowErrors.push({ line: row.line, messages });
      return;
    }
    variants.push({
      id: row.variant.get('variant_id') || String(rowIndex + 1),
      price: row.variant.get('variant_price') || fallbackPrice,
      available: !UNAVAILABLE_WORDS.has(availableWord),
      values,
    });
  });
  return { options, variants };
}

/** One product as the catalog API takes it; empty cells are left out. */
function itemOf(group: ProductRows, defaultCurrency: string): Record<string, unknown> {
  const cells = group.first.product;
  const cell = (column: CsvColumn) => cells.get(column)?.trim() ?? '';
  const price: Record<string, unknown> = {
    amount: cell('price'),
    currency: (cell('currency') || defaultCurrency).toUpperCase(),
  };
  if (cell('frequency') !== '') {
    price.frequency = cell('frequency').toLowerCase();
  }
  const item: Record<string, unknown> = { d: cell('d'), title: cell('title'), price };
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
  const attrs = group.first.attrs.filter((attr) => attr.value !== '');
  if (attrs.length > 0) {
    item.attrs = attrs;
  }
  if (group.variantRows.length > 0) {
    const { options, variants } = variantsOf(group);
    item.options = options;
    item.variants = variants;
    // With variants the listing shows the lowest available variant price (2.1), and a
    // product with none available is sold out unless the file says otherwise.
    price.amount = listingPriceOf(variants) ?? price.amount;
    if (cell('visibility') === '' && !variants.some((variant) => variant.available)) {
      item.visibility = 'sold-out';
    }
  }
  return item;
}

/**
 * Products from a CSV file, each checked with the same schema the server
 * uses. A product with any problem in any of its rows is left out and
 * reported with the lines.
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
  const [headerRow, ...rows] = parsedFile.rows;
  if (headerRow === undefined) {
    result.fileErrors.push('The file is empty.');
    return result;
  }
  const header = headerRow.cells.map((name) => headerCellOf(name));
  const productColumns = header.flatMap((cell) => (cell.kind === 'product' ? [cell.column] : []));
  const missing = REQUIRED_COLUMNS.filter((column) => !productColumns.includes(column));
  if (missing.length > 0) {
    result.fileErrors.push(
      `The file has no ${missing.join(', ')} column. The first row must name the columns.`,
    );
    return result;
  }
  const named = header.flatMap((cell) =>
    cell.kind === 'ignored'
      ? []
      : [
          cell.kind === 'product' || cell.kind === 'variant'
            ? cell.column
            : `${cell.kind}:${cell.name.toLowerCase()}`,
        ],
  );
  const repeated = named.filter((name, index) => named.indexOf(name) !== index);
  if (repeated.length > 0) {
    result.fileErrors.push(
      `The file names the column ${[...new Set(repeated)].join(', ')} more than once.`,
    );
    return result;
  }
  result.ignoredColumns = header.flatMap((cell) =>
    cell.kind === 'ignored' && cell.name !== '' ? [cell.name] : [],
  );
  const groups = new Map<string, ProductRows>();
  const order: ProductRows[] = [];
  for (const { line, cells: row } of rows) {
    const cells = rowCellsOf(line, row, header);
    const d = cells.product.get('d')?.trim() ?? '';
    const earlier = d === '' ? undefined : groups.get(d);
    if (earlier === undefined) {
      const group: ProductRows = {
        first: cells,
        variantRows: hasVariantCells(cells) ? [cells] : [],
        rowErrors: [],
      };
      if (d !== '') {
        groups.set(d, group);
      }
      order.push(group);
      continue;
    }
    if (earlier.variantRows.length === 0 || !hasVariantCells(cells)) {
      // A plain repeat is its own mistake: the earlier product stays as it is.
      result.errors.push({ line, messages: [`d: "${d}" is used by an earlier row`] });
    } else if (hasProductCells(cells)) {
      earlier.rowErrors.push({
        line,
        messages: [
          `a further variant row of "${d}" fills only d, the option:... and variant_... columns; the product's other columns go on its first row`,
        ],
      });
    } else {
      earlier.variantRows.push(cells);
    }
  }
  for (const group of order) {
    const parsed = CatalogItemInputSchema.safeParse(itemOf(group, defaultCurrency));
    const messages = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`);
    if (!parsed.success || group.rowErrors.length > 0) {
      if (messages.length > 0) {
        result.errors.push({ line: group.first.line, messages });
      }
      result.errors.push(...group.rowErrors);
      continue;
    }
    result.items.push(parsed.data);
  }
  result.errors.sort((left, right) => left.line - right.line);
  return result;
}
