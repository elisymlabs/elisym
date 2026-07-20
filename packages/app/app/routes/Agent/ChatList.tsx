import { cn } from '~/lib/cn';
import { chatTitleOf, NEW_CHAT_KEY, type ChatListItem } from './lib/chatList';

interface Props {
  items: ChatListItem[];
  /** Resolved selection: a chat key or `NEW_CHAT_KEY`. */
  selectedKey: string;
  onSelect: (item: ChatListItem) => void;
  onNewChat: () => void;
  /** Chat switching is frozen while a send is in flight. */
  disabled: boolean;
  /** Resolves a capability dTag to its display name (title fallback). */
  cardNameOf: (capability: string) => string;
}

function chatDateLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

/**
 * The Chat tab's sidebar: the same nav pattern as the Terms (policies) panel -
 * a horizontal chip row on mobile, a vertical column on desktop. One item per
 * conversation, one per one-off job, with a draft "New chat" entry on top.
 */
export function ChatList({ items, selectedKey, onSelect, onNewChat, disabled, cardNameOf }: Props) {
  return (
    <nav className="flex flex-row gap-6 overflow-x-auto sm:flex-col sm:overflow-visible">
      <button
        type="button"
        onClick={onNewChat}
        disabled={disabled}
        className={cn(
          'inline-flex shrink-0 cursor-pointer items-center gap-6 rounded-12 border-0 px-12 py-8 text-left text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40',
          selectedKey === NEW_CHAT_KEY
            ? 'bg-tag-bg text-text'
            : 'bg-transparent text-text-2 hover:bg-tag-bg/60',
        )}
      >
        <svg
          aria-hidden
          className="size-12 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New chat
      </button>

      {items.map((item) => {
        const active = item.key === selectedKey;
        const fallback = cardNameOf(item.entries[0]?.capability ?? '');
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item)}
            disabled={disabled}
            className={cn(
              'flex w-160 shrink-0 cursor-pointer flex-col items-start gap-2 rounded-12 border-0 px-12 py-8 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto',
              active ? 'bg-tag-bg text-text' : 'bg-transparent text-text-2 hover:bg-tag-bg/60',
            )}
          >
            <span className="w-full truncate text-[13px] font-medium">
              {chatTitleOf(item, fallback)}
            </span>
            <span className={cn('text-[11px]', active ? 'text-text-2' : 'text-text-2/70')}>
              {item.kind === 'oneshot'
                ? `One-off · ${chatDateLabel(item.lastTs)}`
                : `${item.entries.length} ${item.entries.length === 1 ? 'message' : 'messages'} · ${chatDateLabel(item.lastTs)}`}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
