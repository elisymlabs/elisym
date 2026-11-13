/**
 * What a control plane that writes a store-only home checks before writing
 * it: the node's own rules for its config and products, so a home the node
 * would refuse is refused up front, worded as the node words it.
 */
import { configProblems, priceProblems } from './config';
import { PRODUCT_D_RE, type Product, parseProductText, uneditedProducts } from './products';

export { configProblems, priceProblems };
export type { MerchantConfig } from './config';

/**
 * Every problem `setup` would find with this product set (directory name ->
 * PRODUCT.md), each named by its product; empty when the node takes the set:
 * at least one product, each a directory name the node takes (a dot name,
 * which the node would skip unread, is refused), each readable, none still
 * the `init` example.
 */
export function productSetProblems(texts: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(texts);
  if (entries.length === 0) {
    return ['no products: a store sells at least one'];
  }
  const problems: string[] = [];
  const products: Product[] = [];
  for (const [name, text] of entries) {
    if (!PRODUCT_D_RE.test(name)) {
      problems.push(
        `products/${name}: a product directory is named 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit`,
      );
      continue;
    }
    const parsed = parseProductText(text);
    if (parsed.ok) {
      products.push({ ...parsed.product, d: name, file: `products/${name}/PRODUCT.md` });
    } else {
      problems.push(...parsed.problems.map((problem) => `products/${name}: ${problem}`));
    }
  }
  for (const product of uneditedProducts(products)) {
    problems.push(
      `products/${product.d}: is still the init example: set its title and description`,
    );
  }
  return problems;
}
