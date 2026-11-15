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

/** A value with its object keys sorted, so two equal products compare equal however built. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonical(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sameItem(left: CatalogItemInput, right: CatalogItemInput): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** What a publish sends: the new and changed products and the removed ones' IDs. */
export interface CatalogChange {
  items: CatalogItemInput[];
  hide: string[];
  /** Products the draft keeps as read: not sent at all. */
  untouched: string[];
}

/**
 * The draft against the catalog as read from the relay: only new and changed
 * products are sent, a product gone from the draft is removed by ID, and the
 * rest is not sent. The server still compares what it is sent with the relay.
 */
export function changesOf(
  baseline: readonly CatalogItemInput[],
  draft: readonly CatalogItemInput[],
): CatalogChange {
  const before = new Map(baseline.map((item) => [item.d, item]));
  const kept = new Set(draft.map((item) => item.d));
  const change: CatalogChange = { items: [], hide: [], untouched: [] };
  for (const item of draft) {
    const earlier = before.get(item.d);
    if (earlier !== undefined && sameItem(earlier, item)) {
      change.untouched.push(item.d);
    } else {
      change.items.push(item);
    }
  }
  change.hide = baseline.filter((item) => !kept.has(item.d)).map((item) => item.d);
  return change;
}
