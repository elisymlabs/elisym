import { describe, expect, it } from 'vitest';
import { parseCsv, productsFromCsv } from '../src/lib/csv';

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks, CRLF and a BOM', () => {
    const text =
      '﻿d,title,description\r\na-1,"Mug, large","He said ""hi""\nthen left"\r\nb-2,Plate,\n';
    expect(parseCsv(text)).toEqual([
      ['d', 'title', 'description'],
      ['a-1', 'Mug, large', 'He said "hi"\nthen left'],
      ['b-2', 'Plate', ''],
    ]);
  });

  it('drops blank lines and keeps a last row without a newline', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
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
});
