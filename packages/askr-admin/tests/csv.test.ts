import { describe, expect, it } from 'vitest';
import { MAX_CSV_BYTES, csvSizeProblem, parseCsv, productsFromCsv } from '../src/lib/csv';

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks, CRLF and a BOM', () => {
    const text =
      '\uFEFFd,title,description\r\na-1,"Mug, large","He said ""hi""\r\nthen left"\r\nb-2,Plate,\n';
    expect(parseCsv(text)).toEqual({
      rows: [
        { line: 1, cells: ['d', 'title', 'description'] },
        { line: 2, cells: ['a-1', 'Mug, large', 'He said "hi"\nthen left'] },
        { line: 4, cells: ['b-2', 'Plate', ''] },
      ],
    });
  });

  it('drops blank lines, keeps the line numbers, and keeps a last row without a newline', () => {
    expect(parseCsv('a,b\n\n\n1,2')).toEqual({
      rows: [
        { line: 1, cells: ['a', 'b'] },
        { line: 4, cells: ['1', '2'] },
      ],
    });
  });

  it('reports a quote that never closes, with the line it opens on', () => {
    expect(parseCsv('d,title\na,"one\nb,two').unclosedQuoteLine).toBe(2);
  });
});

describe('productsFromCsv', () => {
  it('turns valid rows into catalog items, with the store currency by default', () => {
    const text = [
      'd,Title,price,currency,summary,description,url,image,visibility,topics,sku',
      'mug-1,Mug,12.50,,Big mug,A large mug,https://shop.example/mug,https://cdn.example/1.jpg|https://cdn.example/2.jpg,on-sale,kitchen|gifts,SKU-1',
      'plate-2,Plate,8,EUR,,,,,sold-out,,',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.errors).toEqual([]);
    expect(result.fileErrors).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      d: 'mug-1',
      title: 'Mug',
      price: { amount: '12.50', currency: 'USD' },
      summary: 'Big mug',
      description: 'A large mug',
      url: 'https://shop.example/mug',
      images: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
      visibility: 'on-sale',
      topics: ['kitchen', 'gifts'],
      sku: 'SKU-1',
    });
    expect(result.items[1]).toMatchObject({
      d: 'plate-2',
      price: { amount: '8', currency: 'EUR' },
      visibility: 'sold-out',
    });
    expect(result.items[1]?.summary).toBeUndefined();
  });

  it('reports each bad row with its line and keeps the good ones', () => {
    const text = [
      'd,title,price,url,visibility',
      'ok-1,Good,1.00,,',
      'bad price,Bad,1.2.3,,',
      'no-title,,5,,',
      'http-link,Link,5,http://shop.example/x,',
      'ok-1,Again,2,,',
      'odd,Odd,3,,gone',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.items.map((item) => item.d)).toEqual(['ok-1']);
    expect(result.errors.map((error) => error.line)).toEqual([3, 4, 5, 6, 7]);
    const messagesOf = (line: number) =>
      result.errors.find((error) => error.line === line)?.messages.join(' | ') ?? '';
    expect(messagesOf(3)).toContain('d:');
    expect(messagesOf(3)).toContain('price.amount:');
    expect(messagesOf(4)).toContain('title:');
    expect(messagesOf(5)).toContain('url:');
    expect(messagesOf(6)).toContain('used by an earlier row');
    expect(messagesOf(7)).toContain('visibility:');
  });

  it('refuses a file without the required columns, and names ignored ones', () => {
    expect(productsFromCsv('name,cost\nMug,1', 'USD').fileErrors).toEqual([
      'The file has no d, title, price column. The first row must name the columns.',
    ]);
    expect(productsFromCsv('', 'USD').fileErrors).toEqual(['The file is empty.']);
    expect(productsFromCsv('d,title,price,color\na,A,1,red', 'USD').ignoredColumns).toEqual([
      'color',
    ]);
  });

  it('uses nothing from a file with an unclosed quote', () => {
    const result = productsFromCsv(
      'd,title,price,summary\na,A,1,"oops\nb,B,2,fine\nc,C,3,fine',
      'USD',
    );
    expect(result.items).toEqual([]);
    expect(result.fileErrors).toEqual([
      'The file has an unclosed quote starting at line 2, so nothing was read. Close the quote and import it again.',
    ]);
  });

  it('names the file line of a bad row after a multi-line cell and blank lines', () => {
    const text = 'd,title,price,description\na,A,1,"two\nlines"\n\nb,B,not-a-price,\n';
    const result = productsFromCsv(text, 'USD');
    expect(result.items.map((item) => item.d)).toEqual(['a']);
    expect(result.errors.map((error) => error.line)).toEqual([5]);
  });

  it('refuses a file over the server catalog cap', () => {
    expect(csvSizeProblem(MAX_CSV_BYTES)).toBeUndefined();
    expect(csvSizeProblem(MAX_CSV_BYTES + 1)).toContain('larger than 8 MB');
  });
});
