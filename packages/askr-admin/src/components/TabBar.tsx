import { TABS, type TabId } from '../lib/tabs';
import { NavIcon } from './NavIcon';

interface Props {
  active: TabId;
  onSelect: (tab: TabId) => void;
}

/** The sections: a column in the sidebar, a scrolling row on a narrow screen. */
export function TabBar({ active, onSelect }: Props) {
  return (
    <nav
      className="-mx-4 flex gap-2 overflow-x-auto md:mx-0 md:flex-col md:overflow-visible"
      aria-label="Sections"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === active ? 'page' : undefined}
          className={`text-14 rounded-8 flex items-center gap-10 px-10 py-7 text-left whitespace-nowrap transition-colors ${
            tab.id === active
              ? 'bg-hover text-text font-medium'
              : 'text-text-2 hover:bg-hover hover:text-text'
          }`}
          onClick={() => onSelect(tab.id)}
        >
          <NavIcon tab={tab.id} />
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
