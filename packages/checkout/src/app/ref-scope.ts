import type { OrderRecord, OrderStore } from '@elisym/commerce/buyer';

/** The refusal of a page whose customer reference cannot be honoured here. */
export const REF_NEEDS_VERIFIED_STORE =
  "A customer reference needs a store verified on this page's domain.";

/**
 * An order belongs to the page's account: the same customer reference, or
 * none on both. A page never shows, resumes or reports another account's order.
 */
export function sameRef(
  record: Pick<OrderRecord, 'customerRef'>,
  ref: string | undefined,
): boolean {
  return record.customerRef === ref;
}

/** The product's orders of the page's account only. */
export async function ordersForRef(
  store: OrderStore,
  productAddress: string,
  ref: string | undefined,
): Promise<OrderRecord[]> {
  const records = await store.forProduct(productAddress);
  return records.filter((record) => sameRef(record, ref));
}
