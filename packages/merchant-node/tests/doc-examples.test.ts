/**
 * Every PRODUCT.md example the docs show is one a node accepts: it parses as a
 * product, and none names a delivery (removed in 0.9.0, refused by name).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProductText, uneditedProducts } from '../src/products';

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

/**
 * The PRODUCT.md examples in a page: a `---` frontmatter naming `priceUsd`, its
 * closing `---`, and the body up to the end of its code fence or heredoc.
 */
export function productExamples(text: string): string[] {
  const lines = text.split('\n');
  const examples: string[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]?.trim() !== '---') {
      continue;
    }
    const close = lines.findIndex((line, index) => index > start && line.trim() === '---');
    if (close === -1) {
      break;
    }
    const frontmatter = lines.slice(start + 1, close);
    if (!frontmatter.some((line) => /^\s*priceUsd:/.test(line))) {
      continue;
    }
    const after = lines.slice(close + 1);
    // The end of a code fence, or of a heredoc (`<<'EOF'`, `<<'PRODUCT'`).
    const end = after.findIndex((line) => /^\s*(```|EOF$|PRODUCT$)/.test(line));
    const body = end === -1 ? after : after.slice(0, end);
    const indent = /^\s*/.exec(lines[start] ?? '')?.[0].length ?? 0;
    examples.push(
      [lines[start], ...frontmatter, lines[close], ...body]
        .map((line) => (line ?? '').slice(indent))
        .join('\n'),
    );
    start = close;
  }
  return examples;
}

describe('the PRODUCT.md examples in the docs', () => {
  const files = [
    ...pages(join(ROOT, 'packages/docs/pages')),
    join(ROOT, 'packages/merchant-node/README.md'),
    join(ROOT, 'examples/demo-store/README.md'),
  ];

  it('parse as products, and none names a delivery', () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const example of productExamples(readFileSync(file, 'utf8'))) {
        if (/^\s*delivery:/m.test(example)) {
          problems.push(`${file}: names a delivery`);
        }
        const parsed = parseProductText(example);
        if (!parsed.ok) {
          problems.push(`${file}: ${parsed.problems.join('; ')}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('leave the mainnet demo product as the init example, which setup refuses until edited', () => {
    const text = readFileSync(join(ROOT, 'examples/demo-store/README.md'), 'utf8');
    const mainnet = productExamples(text.slice(text.indexOf('.elisym-demo-mainnet/products')));
    const parsed = mainnet[0] === undefined ? undefined : parseProductText(mainnet[0]);
    if (parsed === undefined || !parsed.ok) {
      throw new Error('no mainnet demo product found');
    }
    const product = { d: 'demo', file: 'x', ...parsed.product };
    expect(uneditedProducts([product])).toEqual([product]);
  });

  it('finds the examples it checks', () => {
    const found = files.flatMap((file) => productExamples(readFileSync(file, 'utf8')));
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});
