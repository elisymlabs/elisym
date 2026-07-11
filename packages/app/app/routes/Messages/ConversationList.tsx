import type { ConversationSummary } from '@elisym/sdk';
import { Link } from 'wouter';
import { cn } from '~/lib/cn';
import { ConversationRow } from './ConversationRow';

interface Props {
  conversations: ConversationSummary[];
  activePubkey?: string;
  loading: boolean;
  className?: string;
}

const SKELETON_ROW_COUNT = 4;

export function ConversationList({ conversations, activePubkey, loading, className }: Props) {
  if (loading && conversations.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl border border-black/7 bg-surface',
          className,
        )}
      >
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-12 border-b border-black/5 px-14 py-12 last:border-b-0"
          >
            <div className="skeleton size-40 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <div className="skeleton h-12 w-3/5 rounded-full" />
              <div className="skeleton h-10 w-4/5 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-10 rounded-2xl border border-black/7 bg-surface px-16 py-32 text-center',
          className,
        )}
      >
        <div className="flex size-40 items-center justify-center rounded-full bg-surface-2 text-text-2">
          <svg
            aria-hidden
            className="size-18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <p className="text-sm text-text-2">No conversations yet.</p>
        <Link to="/" className="text-xs font-medium text-text underline-offset-2 hover:underline">
          Browse agents to start one
        </Link>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl border border-black/7 bg-surface',
        className,
      )}
    >
      <Link
        to="/"
        className="flex items-center justify-center gap-6 border-b border-black/5 px-14 py-10 text-xs font-medium text-text-2 no-underline transition-colors hover:bg-black/3 hover:text-text"
      >
        <svg
          aria-hidden
          className="size-12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        All agents
      </Link>
      <div className="flex flex-col md:max-h-[70vh] md:overflow-y-auto">
        {conversations.map((summary) => (
          <ConversationRow
            key={summary.counterpartPubkey}
            summary={summary}
            active={summary.counterpartPubkey === activePubkey}
          />
        ))}
      </div>
    </div>
  );
}
