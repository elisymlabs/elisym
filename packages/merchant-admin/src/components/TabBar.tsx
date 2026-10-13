import { Icon, type IconName } from './Icon';

export type Tab = 'overview' | 'orders' | 'products' | 'store' | 'help';

export const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'orders', label: 'Orders', icon: 'receipt' },
  { id: 'products', label: 'Products', icon: 'box' },
  { id: 'store', label: 'Store', icon: 'store' },
  { id: 'help', label: 'Help', icon: 'help' },
];

interface Props {
  active: Tab;
  counts: Partial<Record<Tab, number>>;
  /** The panels are on the page: before the first read they are not. */
  panels: boolean;
  onSelect: (tab: Tab) => void;
}

/** The tab a key moves to from `index`, or undefined for a key that moves nothing. */
function tabForKey(key: string, index: number): Tab | undefined {
  const last = TABS.length - 1;
  const target: Record<string, number> = {
    ArrowRight: index === last ? 0 : index + 1,
    ArrowLeft: index === 0 ? last : index - 1,
    Home: 0,
    End: last,
  };
  const next = target[key];
  return next === undefined ? undefined : TABS[next]?.id;
}

export function TabBar({ active, counts, panels, onSelect }: Props) {
  return (
    <nav
      role="tablist"
      aria-label="Admin sections"
      className="mx-auto flex max-w-1200 gap-4 overflow-x-auto px-12 sm:px-20"
    >
      {TABS.map((tab, index) => {
        const selected = tab.id === active;
        const count = counts[tab.id];
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panels ? `panel-${tab.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const next = tabForKey(event.key, index);
              if (next !== undefined) {
                event.preventDefault();
                onSelect(next);
              }
            }}
            className={`text-14 relative flex shrink-0 items-center gap-6 px-10 py-12 font-medium transition ${
              selected ? 'text-text' : 'text-text-2 hover:text-text'
            }`}
          >
            <Icon name={tab.icon} className="size-16" />
            {tab.label}
            {count !== undefined && (
              <span className="bg-surface-2 text-11 text-text-2 rounded-full px-6 py-1">
                {count}
              </span>
            )}
            {selected && (
              <span
                aria-hidden="true"
                className="bg-ink absolute inset-x-8 bottom-0 h-2 rounded-full"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
