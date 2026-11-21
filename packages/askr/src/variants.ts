import Decimal from 'decimal.js-light';
import { type CatalogItemInput, PRICE_AMOUNT_RE } from './events/catalog-item';

export type VariantInput = NonNullable<CatalogItemInput['variants']>[number];

/**
 * The listing price a product with variants must carry (2.1): the lowest
 * available variant's, or the lowest overall when none is available.
 * Undefined with no variants or a price that is not a plain number.
 */
export function listingPriceOf(variants: readonly VariantInput[]): string | undefined {
  if (variants.length === 0 || !variants.every((variant) => PRICE_AMOUNT_RE.test(variant.price))) {
    return undefined;
  }
  const available = variants.filter((variant) => variant.available);
  const pool = available.length > 0 ? available : variants;
  let lowest = pool[0];
  for (const variant of pool) {
    if (lowest === undefined || new Decimal(variant.price).lessThan(lowest.price)) {
      lowest = variant;
    }
  }
  return lowest?.price;
}
