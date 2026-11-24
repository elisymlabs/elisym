import { ProductInputSchema } from '@merchant-product-rules';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/hosted/lib/api';
import { FIELD_PROBLEMS, NOT_STORABLE_PROBLEM } from '../../src/hosted/lib/product-fields';
import {
  CSV_BAD_HEADER,
  CSV_DUPLICATE_D,
  CSV_EMPTY,
  CSV_ON_SALE,
  CSV_ROW_WIDTH,
  CSV_TOO_LARGE,
  CSV_TOO_MANY_ROWS,
  CSV_UNREADABLE,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  checkProductsCsv,
  importProducts,
  isCapRefusal,
  parseCsv,
} from '../../src/hosted/lib/products-csv';

const HEADER = 'd,title,priceUsd,onSale,summary,url,description';

function rowsOf(text: string) {
  const checked = checkProductsCsv(text);
  if (!checked.ok) {
    throw new Error(`refused: ${JSON.stringify(checked.problems)}`);
  }
  return checked.rows;
}

function problemsOf(text: string) {
  const checked = checkProductsCsv(text);
  if (checked.ok) {
    throw new Error('accepted');
  }
  return checked.problems;
}

describe('parseCsv (RFC 4180)', () => {
  it('splits cells and lines, CRLF or LF, and skips blank lines', () => {
    expect(parseCsv('a,b\r\nc,d\n\ne,\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['c', 'd'] },
      { line: 4, cells: ['e', ''] },
    ]);
  });

  it('reads quoted cells with commas, line breaks and doubled quotes, counting lines', () => {
    expect(parseCsv('"a,1","say ""hi""\nthere"\n"",x\nlast,"q"')).toEqual([
      { line: 1, cells: ['a,1', 'say "hi"\nthere'] },
      { line: 3, cells: ['', 'x'] },
      { line: 4, cells: ['last', 'q'] },
    ]);
  });

  it('keeps a lone CR inside a cell, and reads a final line without a line break', () => {
    expect(parseCsv('a\rb,c')).toEqual([{ line: 1, cells: ['a\rb', 'c'] }]);
  });

  it('drops a leading byte order mark only', () => {
    expect(parseCsv('﻿d,t')).toEqual([{ line: 1, cells: ['d', 't'] }]);
    expect(parseCsv('d,﻿t')).toEqual([{ line: 1, cells: ['d', '﻿t'] }]);
  });

  it('refuses a quote left open, text after a closing quote, and a quote inside a bare cell', () => {
    expect(parseCsv('"open,x\n')).toBeUndefined();
    expect(parseCsv('"a"b,c')).toBeUndefined();
    expect(parseCsv('a"b,c')).toBeUndefined();
    expect(parseCsv('a"b",c')).toBeUndefined();
  });

  it('accepts a closing quote right before a CRLF', () => {
    expect(parseCsv('"a"\r\n"b"')).toEqual([
      { line: 1, cells: ['a'] },
      { line: 2, cells: ['b'] },
    ]);
  });
});

describe('checkProductsCsv', () => {
  it('reads a valid file into the inputs the server takes, empty optional cells left out', () => {
    const rows = rowsOf(
      [
        HEADER,
        'tea-1,  Green tea ,49,true,Leaves,https://shop.example.com/tea,"Fresh, from ""Uji"""',
        'mug,Mug,0.50,FALSE,,,',
        'socks,Socks,5,,,,',
      ].join('\r\n'),
    );
    expect(rows).toEqual([
      {
        line: 2,
        d: 'tea-1',
        input: {
          title: 'Green tea',
          description: 'Fresh, from "Uji"',
          summary: 'Leaves',
          url: 'https://shop.example.com/tea',
          priceUsd: '49',
          onSale: true,
        },
      },
      {
        line: 3,
        d: 'mug',
        input: { title: 'Mug', description: '', priceUsd: '0.50', onSale: false },
      },
      {
        line: 4,
        d: 'socks',
        input: { title: 'Socks', description: '', priceUsd: '5', onSale: true },
      },
    ]);
  });

  it('takes the columns in any order, the optional ones left out', () => {
    expect(rowsOf('priceUsd,d,title\n3,b,Bee\n')).toEqual([
      { line: 2, d: 'b', input: { title: 'Bee', description: '', priceUsd: '3', onSale: true } },
    ]);
  });

  it('reads a file with a byte order mark (a spreadsheet export)', () => {
    expect(rowsOf(`﻿${HEADER}\nb,Bee,3,,,,`).map((row) => row.d)).toEqual(['b']);
  });

  it('reports every invalid line, each field by its fixed sentence, and sends nothing', () => {
    const problems = problemsOf(
      [
        HEADER,
        '../x,,0,maybe,,http://shop.example.com,',
        'ok,Fine,1,,,,',
        'short,Short',
        'wide,Wide,1,,,,,',
        `long,${'t'.repeat(201)},1.1234567,,${'s'.repeat(1025)},,${'x'.repeat(65_537)}`,
        'ok,Again,2,,,,',
        `nul,Bad${String.fromCharCode(0)},1,,,,`,
        // Too long and not storable: the field's first issue, its length rule, is said.
        `both,${'t'.repeat(201)}${String.fromCharCode(0)},1,,,,`,
      ].join('\n'),
    );
    expect(problems).toEqual([
      { line: 2, text: `d: ${FIELD_PROBLEMS.d}` },
      { line: 2, text: `title: ${FIELD_PROBLEMS.title}` },
      { line: 2, text: `priceUsd: ${FIELD_PROBLEMS.priceUsd}` },
      { line: 2, text: `url: ${FIELD_PROBLEMS.url}` },
      { line: 2, text: `onSale: ${CSV_ON_SALE}` },
      { line: 4, text: CSV_ROW_WIDTH },
      { line: 5, text: CSV_ROW_WIDTH },
      { line: 6, text: `title: ${FIELD_PROBLEMS.title}` },
      { line: 6, text: `priceUsd: ${FIELD_PROBLEMS.priceUsd}` },
      { line: 6, text: `summary: ${FIELD_PROBLEMS.summary}` },
      { line: 6, text: `description: ${FIELD_PROBLEMS.description}` },
      { line: 7, text: `d: ${CSV_DUPLICATE_D}` },
      { line: 8, text: `title: ${NOT_STORABLE_PROBLEM}` },
      { line: 9, text: `title: ${FIELD_PROBLEMS.title}` },
    ]);
  });

  it('refuses an id already on an earlier line, even one invalid there', () => {
    expect(problemsOf(`${HEADER}\na,A,0,,,,\n a ,B,2,,,,`)).toEqual([
      { line: 2, text: `priceUsd: ${FIELD_PROBLEMS.priceUsd}` },
      { line: 3, text: `d: ${CSV_DUPLICATE_D}` },
    ]);
  });

  it('says nothing of a duplicate for missing ids: each is reported as missing', () => {
    expect(problemsOf(`${HEADER}\n,A,1,,,,\n ,B,2,,,,`)).toEqual([
      { line: 2, text: `d: ${FIELD_PROBLEMS.d}` },
      { line: 3, text: `d: ${FIELD_PROBLEMS.d}` },
    ]);
  });

  it('reads the id trimmed, as it is sent', () => {
    expect(rowsOf(`${HEADER}\n  tea ,Tea,1,,,,`)[0]?.d).toBe('tea');
  });

  it('refuses a header that is not the known columns, once each, with the required ones', () => {
    for (const header of [
      'd,title',
      'd,title,priceUsd,price',
      'd,title,priceUsd,d',
      'D,title,priceUsd',
    ]) {
      expect(problemsOf(`${header}\nx,y,1,z`), header).toEqual([{ line: 1, text: CSV_BAD_HEADER }]);
    }
    expect(rowsOf(' d , title ,priceUsd\nx,y,1')).toHaveLength(1);
  });

  it('refuses an empty file, a header alone, and an unreadable one', () => {
    expect(problemsOf('')).toEqual([{ line: undefined, text: CSV_EMPTY }]);
    expect(problemsOf(`${HEADER}\n\n`)).toEqual([{ line: undefined, text: CSV_EMPTY }]);
    expect(problemsOf(`${HEADER}\n"a,b`)).toEqual([{ line: undefined, text: CSV_UNREADABLE }]);
  });

  it('caps the size in bytes and the number of products', () => {
    const header = 'd,title,priceUsd,description\n';
    /** Products whose descriptions fill the file to exactly `bytes`, each within the 64K rule. */
    const filled = (bytes: number, last = 'x') => {
      const lines: string[] = [];
      let size = header.length;
      for (let index = 0; size < bytes; index += 1) {
        const prefix = `${index === 0 ? '' : '\n'}p${index},P,1,`;
        const room = Math.min(60_000, bytes - size - prefix.length);
        const final = size + prefix.length + room >= bytes;
        lines.push(`${prefix}${'x'.repeat(room - 1)}${final ? last : 'x'}`);
        size += prefix.length + room;
      }
      return `${header}${lines.join('')}`;
    };
    expect(new TextEncoder().encode(filled(MAX_CSV_BYTES)).length).toBe(MAX_CSV_BYTES);
    expect(rowsOf(filled(MAX_CSV_BYTES)).length).toBeGreaterThan(30);
    // One byte over, counted in UTF-8: the same length in characters, a two-byte one last.
    expect(problemsOf(filled(MAX_CSV_BYTES, 'é'))).toEqual([
      { line: undefined, text: CSV_TOO_LARGE },
    ]);
    const lines = (count: number) =>
      [HEADER, ...Array.from({ length: count }, (_, index) => `p${index},P,1,,,,`)].join('\n');
    expect(rowsOf(lines(MAX_CSV_ROWS))).toHaveLength(MAX_CSV_ROWS);
    expect(problemsOf(lines(MAX_CSV_ROWS + 1))).toEqual([
      { line: undefined, text: CSV_TOO_MANY_ROWS },
    ]);
  });
});

describe('the shared product rules', () => {
  it('raise issues only on the fields the admin names, plus onSale (a checkbox)', () => {
    const named = Object.keys(FIELD_PROBLEMS).filter((field) => field !== 'd');
    expect(Object.keys(ProductInputSchema.shape).sort()).toEqual([...named, 'onSale'].sort());
  });
});

describe('importProducts', () => {
  const rows = rowsOf(`${HEADER}\na,A,1,,,,\nb,B,2,,,,\nc,C,3,,,,`);

  it('writes every row in order, one at a time', async () => {
    const order: string[] = [];
    let running = 0;
    const put = vi.fn(async (d: string) => {
      running += 1;
      expect(running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(d);
      running -= 1;
    });
    const progress: number[] = [];
    expect(await importProducts(rows, put, (written) => progress.push(written))).toEqual({
      done: true,
      written: 3,
    });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(put.mock.calls[1]).toEqual([
      'b',
      { title: 'B', description: '', priceUsd: '2', onSale: true },
    ]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it('stops at the cap refusal and says how far it got', async () => {
    const cap = new ApiError(409, 'product_cap');
    const put = vi.fn(async (d: string) => {
      if (d === 'b') {
        throw cap;
      }
    });
    expect(await importProducts(rows, put)).toEqual({
      done: false,
      written: 1,
      failed: rows[1],
      error: cap,
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(isCapRefusal(cap)).toBe(true);
    expect(isCapRefusal(new ApiError(400, 'bad_price'))).toBe(false);
    expect(isCapRefusal({ name: 'ApiError', code: 'product_cap' })).toBe(false);
  });
});
