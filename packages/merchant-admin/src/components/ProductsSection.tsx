import { useState } from 'react';
import type { Snapshot } from '../lib/core';
import { countText } from '../lib/count';
import { Code } from './Code';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { Section } from './Section';

interface Props {
  products: Snapshot['allProducts'];
}

type SaleFilter = 'all' | 'on' | 'off';

const FILTERS: { value: SaleFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'On sale' },
  { value: 'off', label: 'Sold out' },
];

/** Every listing of the store read so far, read-only: the node publishes them. */
export function ProductsSection({ products }: Props) {
  const [filter, setFilter] = useState<SaleFilter>('all');
  const [query, setQuery] = useState('');
  const lines = products?.lines ?? [];
  const needle = query.trim().toLowerCase();
  const shown = lines.filter(
    (product) =>
      (filter === 'all' || product.onSale === (filter === 'on')) &&
      (needle === '' || `${product.title}\n${product.d}`.toLowerCase().includes(needle)),
  );
  const onSale = lines.filter((product) => product.onSale).length;
  return (
    <Section
      title="Products"
      description={
        <>
          {`${countText(lines.length, 'product')}, ${onSale} on sale. Read-only here: your node publishes them with `}
          <Code>setup</Code>.
        </>
      }
    >
      {products?.incomplete === true && (
        <p
          id="products-incomplete"
          className="rounded-12 bg-warn-bg text-14 text-warn flex items-center gap-8 px-14 py-10"
        >
          <Icon name="alert" className="size-16 shrink-0" />
          The store may have more products than shown.
        </p>
      )}
      {lines.length > 0 && (
        <div className="flex flex-col gap-12 md:flex-row md:items-center md:justify-between">
          <div role="group" aria-label="Filter products" className="flex flex-wrap gap-6">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
                className={`text-13 rounded-full border px-12 py-4 font-medium ${
                  filter === option.value
                    ? 'border-ink bg-ink text-ink-text'
                    : 'border-line bg-surface text-text-2 hover:text-text'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="rounded-10 border-line bg-surface focus-within:border-accent-ink flex items-center gap-8 border px-10 md:w-280">
            <Icon name="search" className="text-text-3 size-16 shrink-0" />
            <span className="sr-only">Search products</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title or id"
              autoComplete="off"
              spellCheck={false}
              className="text-14 placeholder:text-text-3 min-w-0 flex-1 bg-transparent py-8 outline-none"
            />
          </label>
        </div>
      )}
      <ul id="products" className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((product) => (
          <li
            key={product.address}
            className="rounded-16 border-line bg-surface hover:border-line-2 flex flex-col gap-12 border p-16 transition"
          >
            <div className="flex items-start justify-between gap-12">
              <span className="rounded-10 bg-surface-2 text-text-3 grid size-36 shrink-0 place-items-center">
                <Icon name="box" className="size-18" />
              </span>
              <span
                className={`text-12 rounded-full px-8 py-2 font-medium ${product.onSale ? 'bg-green-bg text-green' : 'bg-surface-2 text-text-2'}`}
              >
                {product.onSale ? 'on sale' : 'sold out'}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-15 truncate font-semibold" title={product.title}>
                {product.title}
              </p>
              <p className="text-12 text-text-3 truncate font-mono" title={product.d}>
                {product.d}
              </p>
            </div>
            <p className="text-18 mt-auto font-semibold tracking-tight">{product.price}</p>
          </li>
        ))}
      </ul>
      {lines.length === 0 && (
        <div className="rounded-16 border-line bg-surface border">
          <EmptyState icon="box" title="No product found.">
            Products appear here once your node publishes them with <Code>setup</Code>.
          </EmptyState>
        </div>
      )}
      {lines.length > 0 && shown.length === 0 && (
        <div className="rounded-16 border-line bg-surface border">
          <EmptyState icon="search" title="No product matches these filters." />
        </div>
      )}
    </Section>
  );
}
