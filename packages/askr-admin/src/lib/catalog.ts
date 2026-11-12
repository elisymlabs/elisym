import type { CatalogItemInput } from '@elisym/askr';

/**
 * The whole catalog after one change. `POST /v1/admin/catalog` replaces the
 * catalog: whatever is not in the list it gets is deleted, so every change
 * here returns the full list.
 */
export function upsertItem(
  catalog: readonly CatalogItemInput[],
  item: CatalogItemInput,
): CatalogItemInput[] {
  const index = catalog.findIndex((existing) => existing.d === item.d);
  if (index === -1) {
    return [...catalog, item];
  }
  return catalog.map((existing, existingIndex) => (existingIndex === index ? item : existing));
}

export function removeItem(catalog: readonly CatalogItemInput[], d: string): CatalogItemInput[] {
  return catalog.filter((existing) => existing.d !== d);
}

/**
 * The catalog after a CSV import: `merge` adds the file's products to the
 * current ones (a row with an existing `d` replaces it), `replace` keeps only
 * the file's.
 */
export function importItems(
  catalog: readonly CatalogItemInput[],
  imported: readonly CatalogItemInput[],
  mode: 'merge' | 'replace',
): CatalogItemInput[] {
  const base: CatalogItemInput[] = mode === 'replace' ? [] : [...catalog];
  return imported.reduce((list, item) => upsertItem(list, item), base);
}
