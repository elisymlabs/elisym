import { timeAgo, truncateKey } from '@elisym/sdk';
import type { ConversationSummary } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { Link } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
import { cn } from '~/lib/cn';
import { VERIFIED_PUBKEYS } from '~/lib/verified';

interface Props {
  conversations: ConversationSummary[];
  activePubkey?: string;
  loading: boolean;
  className?: string;
}

const PREVIEW_MAX = 80;

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

export function ConversationList({ conversations, activePubkey, loading, className }: Props) {
  if (loading && conversations.length === 0) {
    return (
      <div className={cn('rounded-2xl border border-black/7 bg-surface p-16', className)}>
        <p className="text-sm text-text-2">Loading conversations…</p>
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className={cn('rounded-2xl border border-black/7 bg-surface p-16', className)}>
        <p className="text-sm text-text-2">
          No conversations yet. Open an agent page and hit Message to start one.
        </p>
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
      {conversations.map((summary) => {
        const pubkey = summary.counterpartPubkey;
        const active = pubkey === activePubkey;
        const unread = summary.unreadCount ?? 0;
        return (
          <Link
            key={pubkey}
            to={`/messages/${pubkey}`}
            className={cn(
              'flex items-center gap-12 border-b border-black/5 px-14 py-12 no-underline transition-colors last:border-b-0',
              active ? 'bg-surface-2' : 'hover:bg-black/3',
            )}
          >
            <div className="size-40 shrink-0 overflow-hidden rounded-full">
              <MarbleAvatar name={pubkey} size={40} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-4">
                <span className="truncate font-mono text-xs font-medium text-text">
                  {truncateKey(nip19.npubEncode(pubkey), 6)}
                </span>
                {VERIFIED_PUBKEYS.has(pubkey) && <VerifiedBadge className="size-14 shrink-0" />}
                <span className="ml-auto shrink-0 text-[10px] text-text-2 opacity-60">
                  {timeAgo(summary.lastMessage.createdAt * 1000)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-8">
                <span className="min-w-0 flex-1 truncate text-xs text-text-2">
                  {summary.lastMessage.isMine ? 'You: ' : ''}
                  {preview(summary.lastMessage.content)}
                </span>
                {unread > 0 && (
                  <span className="inline-flex h-16 min-w-16 shrink-0 items-center justify-center rounded-full bg-accent px-4 text-[10px] font-semibold text-white">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
