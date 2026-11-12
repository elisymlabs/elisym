import { TABS, type TabId } from '../lib/tabs';

interface Props {
  active: TabId;
  onSelect: (tab: TabId) => void;
}

export function TabBar({ active, onSelect }: Props) {
  return (
    <nav className="border-line flex gap-4 overflow-x-auto border-b" aria-label="Sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === active ? 'page' : undefined}
          className={`text-14 -mb-px border-b-2 px-12 py-10 whitespace-nowrap ${
            tab.id === active ? 'border-ink font-semibold' : 'text-text-2 border-transparent'
          }`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
