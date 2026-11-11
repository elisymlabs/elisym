import type { CatalogItem } from '@elisym/comcore';
import Decimal from 'decimal.js-light';
import { STRINGS } from './strings';

/** Minor-unit digits of an ISO 4217 currency, from the platform when it knows it. */
function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** A price string from a signed listing, exact: padded to the currency's minor units, never rounded. */
export function formatAmount(amount: string, currency: string): string {
  const value = new Decimal(amount);
  const digits = currencyDigits(currency);
  const text = value.decimalPlaces() <= digits ? value.toFixed(digits) : value.toString();
  return `${text} ${currency}`;
}

export function formatPrice(
  item: Pick<CatalogItem, 'price' | 'priceFrom'>,
  variantPrice?: string,
): string {
  if (variantPrice !== undefined) {
    return formatAmount(variantPrice, item.price.currency);
  }
  const base = formatAmount(item.price.amount, item.price.currency);
  const withFrequency = item.price.frequency ? `${base} / ${item.price.frequency}` : base;
  return item.priceFrom ? `${STRINGS.from} ${withFrequency}` : withFrequency;
}
