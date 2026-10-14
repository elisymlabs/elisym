import type { OrderState } from '../lib/core';
import { STATE_ORDER, STATE_SHORT, type StateFilter } from '../lib/orders';
import { Icon } from './Icon';

interface Props {
  total: number;
  counts: Record<OrderState, number>;
  state: StateFilter;
  query: string;
  onState: (state: StateFilter) => void;
  onQuery: (query: string) => void;
}

export function OrderFilters({ total, counts, state, query, onState, onQuery }: Props) {
  const options: { value: StateFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: total },
    ...STATE_ORDER.filter((value) => counts[value] > 0 || state === value).map((value) => ({
      value,
      label: STATE_SHORT[value],
      count: counts[value],
    })),
  ];
  return (
    <div className="flex flex-col gap-12 md:flex-row md:items-center md:justify-between">
      <div role="group" aria-label="Filter by state" className="flex flex-wrap gap-6">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={state === option.value}
            onClick={() => onState(option.value)}
            className={`text-13 rounded-full border px-12 py-4 font-medium ${
              state === option.value
                ? 'border-ink bg-ink text-ink-text'
                : 'border-line bg-surface text-text-2 hover:text-text'
            }`}
          >
            {option.label}
            <span className={`ml-6 ${state === option.value ? '' : 'text-text-3'}`}>
              {option.count}
            </span>
          </button>
        ))}
      </div>
      <label className="rounded-10 border-line bg-surface focus-within:border-accent-ink flex items-center gap-8 border px-10 md:w-280">
        <Icon name="search" className="text-text-3 size-16 shrink-0" />
        <span className="sr-only">Search orders</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Order, email, ref, buyer"
          autoComplete="off"
          spellCheck={false}
          className="text-14 placeholder:text-text-3 min-w-0 flex-1 bg-transparent py-8 outline-none"
        />
      </label>
    </div>
  );
}
