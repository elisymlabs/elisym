import { Link } from 'wouter';
import { useLiveMessages, useUnreadTotal } from '~/hooks/useMessages';
import { cn } from '~/lib/cn';

interface Props {
  dark: boolean;
}

/**
 * Header entry point for private messages. Also hosts the app-wide live DM
 * subscription (the header is always mounted, so the badge stays current on
 * every page).
 */
export function MessagesNavLink({ dark }: Props) {
  useLiveMessages();
  const unread = useUnreadTotal();

  return (
    <Link
      to="/messages"
      aria-label={unread > 0 ? `Messages, ${unread} unread` : 'Messages'}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-12 border p-8 no-underline transition-colors sm:px-10',
        dark
          ? 'border-white/8 bg-white/8 text-white hover:bg-white/10'
          : 'border-black/15 bg-transparent text-surface-dark hover:bg-black/4',
      )}
    >
      <svg
        aria-hidden
        className="size-16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-6 -right-6 inline-flex h-16 min-w-16 items-center justify-center rounded-full bg-accent px-4 text-[10px] font-semibold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
