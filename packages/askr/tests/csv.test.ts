import { describe, expect, it } from 'vitest';
import { CSV_EXAMPLE, MAX_CSV_BYTES, csvSizeProblem, parseCsv, productsFromCsv } from '../src/csv';

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
  it('prices a row without a currency in the store currency it is given, and keeps a stated one', () => {
    const result = productsFromCsv('d,title,price,currency\na,A,5,\nb,B,6,USD', 'EUR');
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.price)).toEqual([
      { amount: '5', currency: 'EUR' },
      { amount: '6', currency: 'USD' },
    ]);
  });

  it('caps a file at 8 MB, as the CLI and admin hints say', () => {
    expect(MAX_CSV_BYTES).toBe(8 * 1024 * 1024);
    expect(csvSizeProblem(MAX_CSV_BYTES)).toBeUndefined();
    expect(csvSizeProblem(MAX_CSV_BYTES + 1)).toContain('8 MB');
  });

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

  it('reads frequency, attr: columns and option: variant rows into one product', () => {
    const text = [
      'd,title,price,frequency,attr:Material,attr:Fit,option:Size,option:Color,variant_id,variant_price,variant_available',
      'tee,Tee,99,,Cotton,,S,Black,t-s,20,yes',
      'tee,,,,,,M,Black,,22,',
      'tee,,,,,,L,White,t-l,,no',
      'box,Coffee box,15,Month,,,,,,,',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.errors).toEqual([]);
    expect(result.ignoredColumns).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      d: 'tee',
      // The lowest in-stock variant price, not the 99 of the price cell.
      price: { amount: '20', currency: 'USD' },
      attrs: [{ name: 'Material', value: 'Cotton' }],
      options: [
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Color', values: ['Black', 'White'] },
      ],
      variants: [
        { id: 't-s', price: '20', available: true, values: ['S', 'Black'] },
        { id: '1', price: '22', available: true, values: ['M', 'Black'] },
        { id: 't-l', price: '99', available: false, values: ['L', 'White'] },
      ],
      visibility: 'on-sale',
    });
    expect(result.items[1]).toMatchObject({
      d: 'box',
      price: { amount: '15', currency: 'USD', frequency: 'month' },
      attrs: [],
      options: [],
      variants: [],
    });
  });

  it('uses only the options a product fills, and a product with nothing in stock is sold out', () => {
    const text = [
      'd,title,price,visibility,option:Size,option:Color,variant_available',
      'cap,Cap,10,,,Red,no',
      'cap,,,,,Blue,no',
      'hat,Hat,12,pre-order,M,,no',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      options: [{ name: 'Color', values: ['Red', 'Blue'] }],
      visibility: 'sold-out',
    });
    expect(result.items[1]).toMatchObject({
      options: [{ name: 'Size', values: ['M'] }],
      visibility: 'pre-order',
    });
  });

  it('leaves out a whole product when one of its variant rows is wrong, with the lines', () => {
    const text = [
      'd,title,price,summary,option:Size,option:Color,variant_available,variant_price',
      'tee,Tee,20,,S,Red,,',
      'tee,,,,,Blue,,',
      'tee,,,,M,Red,maybe,',
      'tee,,,more,L,Red,,',
      'mug,Mug,5,,,,,',
      'mug,Mug again,6,,,,,',
      'cup,Cup,3,,S,,,abc',
      'ok,Ok,1,,,,,',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.items.map((item) => item.d)).toEqual(['mug', 'ok']);
    const messagesOf = (line: number) =>
      result.errors.find((error) => error.line === line)?.messages.join(' | ') ?? '';
    expect(result.errors.map((error) => error.line)).toEqual([3, 4, 5, 7, 8]);
    expect(messagesOf(3)).toContain('option:Size: this variant needs a value');
    expect(messagesOf(4)).toContain('variant_available: write yes or no');
    expect(messagesOf(5)).toContain('fills only d');
    expect(messagesOf(7)).toContain('used by an earlier row');
    expect(messagesOf(8)).toContain('variants.0.price');
  });

  it('refuses a column named twice, attr:/option: names compared without case', () => {
    expect(productsFromCsv('d,title,price,Price\na,A,1,2', 'USD').fileErrors).toEqual([
      'The file names the column price more than once.',
    ]);
    expect(
      productsFromCsv('d,title,price,option:Size,option:size\na,A,1,S,M', 'USD').fileErrors,
    ).toEqual(['The file names the column option:size more than once.']);
    expect(
      productsFromCsv('d,title,price,attr:,option: \na,A,1,x,y', 'USD').ignoredColumns,
    ).toEqual(['attr:', 'option:']);
  });

  it('reads the example file without a problem', () => {
    const result = productsFromCsv(CSV_EXAMPLE, 'USD');
    expect(result.errors).toEqual([]);
    expect(result.fileErrors).toEqual([]);
    expect(result.ignoredColumns).toEqual([]);
    expect(result.items.map((item) => [item.d, item.variants?.length ?? 0])).toEqual([
      ['mug-1', 0],
      ['tee-1', 4],
      ['box-1', 0],
    ]);
  });

  it('reads a plain first row followed by its variant rows, the usual export layout', () => {
    const text = [
      'd,title,price,attr:Fit,option:Size,variant_price',
      'a,A,5,Loose,,',
      'a,,,,S,',
      'a,,,,M,7',
    ].join('\n');
    const result = productsFromCsv(text, 'USD');
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      attrs: [{ name: 'Fit', value: 'Loose' }],
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: '1', price: '5', values: ['S'] },
        { id: '2', price: '7', values: ['M'] },
      ],
    });
  });

  it('gives automatic variant ids no row names, and reports a repeated combination on its row', () => {
    const ids = productsFromCsv(
      ['d,title,price,option:Size,variant_id', 'a,A,5,S,2', 'a,,,M,', 'a,,,L,1'].join('\n'),
      'USD',
    );
    expect(ids.errors).toEqual([]);
    expect(ids.items[0]?.variants?.map((variant) => variant.id)).toEqual(['2', '3', '1']);
    const repeated = productsFromCsv(
      ['d,title,price,option:Size,variant_price', 'a,A,5,S,6', 'a,,,S,7'].join('\n'),
      'USD',
    );
    expect(repeated.items).toEqual([]);
    expect(repeated.errors).toEqual([
      { line: 3, messages: ['this combination of option values is already on line 2'] },
    ]);
  });

  it('reads * as any value, never as a choice, and refuses an option that has only *', () => {
    const any = productsFromCsv(
      ['d,title,price,option:Size,option:Color', 'a,A,5,*,Red', 'a,,,M,Blue'].join('\n'),
      'USD',
    );
    expect(any.errors).toEqual([]);
    expect(any.items[0]).toMatchObject({
      options: [
        { name: 'Size', values: ['M'] },
        { name: 'Color', values: ['Red', 'Blue'] },
      ],
      variants: [{ values: ['*', 'Red'] }, { values: ['M', 'Blue'] }],
    });
    const only = productsFromCsv(['d,title,price,option:Size', 'a,A,5,*'].join('\n'), 'USD');
    expect(only.items).toEqual([]);
    expect(only.errors).toEqual([
      { line: 2, messages: ['option:Size: needs at least one value other than *'] },
    ]);
  });

  it('puts a variant problem the schema finds on that variant row', () => {
    const result = productsFromCsv(
      ['d,title,price,option:Size,variant_price', 'a,A,5,S,', 'a,,,M,abc', 'a,,,L,7'].join('\n'),
      'USD',
    );
    expect(result.items).toEqual([]);
    expect(result.errors.map((error) => error.line)).toEqual([3]);
    expect(result.errors[0]?.messages.join(' ')).toContain('variants.1.price');
  });

  it('refuses variant columns without an option value, and attributes on a further row', () => {
    const lone = productsFromCsv(
      ['d,title,price,option:Size,variant_available', 'a,A,5,,no', 'b,B,5,S,', 'b,,,,no'].join(
        '\n',
      ),
      'USD',
    );
    expect(lone.items).toEqual([]);
    expect(lone.errors.map((error) => [error.line, error.messages.join(' ')])).toEqual([
      [2, expect.stringContaining('fill its option:... values too')],
      [4, expect.stringContaining('fill its option:... values too')],
    ]);
    const attr = productsFromCsv(
      ['d,title,price,attr:Fit,option:Size', 'a,A,5,,S', 'a,,,Loose,M'].join('\n'),
      'USD',
    );
    expect(attr.items).toEqual([]);
    expect(attr.errors[0]).toMatchObject({ line: 3 });
    expect(attr.errors[0]?.messages.join(' ')).toContain('fills only d');
  });

  it('puts every message for one line into one entry', () => {
    const result = productsFromCsv('d,title,price\n,,x', 'USD');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(2);
    expect(result.errors[0]?.messages.length).toBeGreaterThan(1);
  });

  it('refuses a variant that a * variant already stands for, with both lines', () => {
    const result = productsFromCsv(
      ['d,title,price,option:Size,option:Color', 'a,A,5,XL,*', 'a,,,XL,Black', 'a,,,S,Black'].join(
        '\n',
      ),
      'USD',
    );
    expect(result.items).toEqual([]);
    expect(result.errors).toEqual([
      {
        line: 3,
        messages: [
          "this variant overlaps the one on line 2: * stands for any value, so a shopper's choice would match both",
        ],
      },
    ]);
  });

  it('refuses a * row after a specific one it overlaps, naming that row', () => {
    const result = productsFromCsv(
      ['d,title,price,option:Size,option:Color', 'a,A,5,M,Blue', 'a,,,S,Red', 'a,,,S,*'].join('\n'),
      'USD',
    );
    expect(result.items).toEqual([]);
    expect(result.errors).toEqual([
      {
        line: 4,
        messages: [
          "this variant overlaps the one on line 3: * stands for any value, so a shopper's choice would match both",
        ],
      },
    ]);
  });
});
