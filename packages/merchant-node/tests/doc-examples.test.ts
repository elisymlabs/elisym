/**
 * Every example delivery value the docs show is the one `init` writes (or
 * empty), so an example copied into a product is refused by `setup` and never
 * sold: a buyer would get example.com.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_DELIVERY_VALUE } from '../src/products';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return pages(path);
    }
    return /\.mdx?$/.test(entry.name) ? [path] : [];
  });
}

/** The `value` of every delivery an example writes, in YAML or JSON. */
function deliveryValues(text: string): string[] {
  const yaml = [...text.matchAll(/^\s*value:\s*"?([^"\n]*)"?\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
  const json = [...text.matchAll(/delivery[^}]*?"?value"?\s*:\s*"([^"]*)"/g)].map(
    (match) => match[1] ?? '',
  );
  return [...yaml, ...json];
}

describe('the example delivery values in the docs', () => {
  const files = [
    ...pages(join(ROOT, 'packages/docs/pages')),
    join(ROOT, 'packages/merchant-node/README.md'),
    join(ROOT, 'examples/demo-store/README.md'),
  ];

  it('are the init placeholder, or not an example.com link at all', () => {
    const found: string[] = [];
    for (const file of files) {
      for (const value of deliveryValues(readFileSync(file, 'utf8'))) {
        if (value.includes('example.com') && value !== PLACEHOLDER_DELIVERY_VALUE) {
          found.push(`${file}: ${value}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('finds the examples it checks', () => {
    const all = files.flatMap((file) => deliveryValues(readFileSync(file, 'utf8')));
    expect(all).toContain(PLACEHOLDER_DELIVERY_VALUE);
  });
});
