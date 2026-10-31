import { decodeProductNaddr } from '@elisym/commerce';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '@elisym/react/constants';
import { describe, expect, it } from 'vitest';
import { NEW_PRODUCT, PRODUCT_NAME_RE, productSnippet } from '../../src/cloud/lib/snippet';

const STORE = '1'.repeat(64);

describe("a product's snippet", () => {
  it("names the product's naddr (this store, this product, the relay hints) and the pinned loader", () => {
    const snippet = productSnippet(
      STORE,
      'course',
      ['wss://relay.elisym.network', 'wss://nos.lol'],
      'devnet',
    );
    const naddr = /product="(naddr1[a-z0-9]+)"/.exec(snippet)?.[1] ?? '';
    expect(decodeProductNaddr(naddr)).toEqual({
      storePubkey: STORE,
      d: 'course',
      relays: ['wss://relay.elisym.network', 'wss://nos.lol'],
    });
    expect(snippet).toBe(
      [
        `<elisym-buy product="${naddr}" network="devnet"></elisym-buy>`,
        '<script',
        `  src="${V3_LOADER_SRC}"`,
        `  integrity="${V3_LOADER_INTEGRITY}"`,
        '  crossorigin="anonymous"',
        '></script>',
      ].join('\n'),
    );
  });

  it("a partner's merchant names the partner hostname's v4 loader and the neutral tag", () => {
    const loader = {
      src: 'https://pay.acme.example/v4/embed.js',
      integrity: `sha384-${'A'.repeat(64)}`,
    };
    const snippet = productSnippet(STORE, 'course', [], 'mainnet', loader);
    const naddr = /product="(naddr1[a-z0-9]+)"/.exec(snippet)?.[1] ?? '';
    expect(snippet).toBe(
      [
        `<pay-buy product="${naddr}" network="mainnet"></pay-buy>`,
        '<script',
        `  src="${loader.src}"`,
        `  integrity="${loader.integrity}"`,
        '  crossorigin="anonymous"',
        '></script>',
      ].join('\n'),
    );
    expect(snippet).not.toMatch(/elisym/);
  });
});

describe('product names and a new product', () => {
  it('takes the names the cloud takes', () => {
    for (const name of ['course', 'a', 'course-2', '9lives', 'a'.repeat(63)]) {
      expect(PRODUCT_NAME_RE.test(name), name).toBe(true);
    }
    for (const name of [
      '',
      'Course',
      '-course',
      'course_2',
      'course.2',
      'a'.repeat(64),
      'my course',
    ]) {
      expect(PRODUCT_NAME_RE.test(name), name).toBe(false);
    }
  });

  it('a new product starts as a PRODUCT.md with its title to fill in', () => {
    expect(NEW_PRODUCT).toBe('---\ntitle: \npriceUsd: "10"\n---\n\nWhat the buyer pays for.\n');
  });
});
