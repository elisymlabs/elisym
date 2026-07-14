import { timeAgo, truncateKey } from '@elisym/sdk';
import type { ConversationSummary } from '@elisym/sdk';
import { nip19 } from 'nostr-tools';
import { useState } from 'react';
import { Link } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
import { useCachedAgentProfile } from '~/hooks/useCachedAgentProfile';
import { cn } from '~/lib/cn';
import { VERIFIED_PUBKEYS } from '~/lib/verified';

interface Props {
  summary: ConversationSummary;
  active: boolean;
}

const PREVIEW_MAX = 80;

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

export function ConversationRow({ summary, active }: Props) {
  const pubkey = summary.counterpartPubkey;
  const agent = useCachedAgentProfile(pubkey);
  const [imgError, setImgError] = useState(false);
  const unread = summary.unreadCount ?? 0;
  const displayName = agent?.name?.trim() || truncateKey(nip19.npubEncode(pubkey), 6);

  return (
    <Link
      to={`/messages/${pubkey}`}
      className={cn(
        'flex items-center gap-12 border-b border-black/5 px-14 py-12 no-underline transition-colors last:border-b-0',
        active ? 'bg-surface-2' : 'hover:bg-black/3',
      )}
    >
      <div className="flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {agent?.picture && !imgError ? (
          <img
            src={agent.picture}
            alt={displayName}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <MarbleAvatar name={pubkey} size={40} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-4">
          <span
            className={cn(
              'truncate text-xs text-text',
              agent?.name ? 'font-sans' : 'font-mono',
              unread > 0 ? 'font-semibold' : 'font-medium',
            )}
          >
            {displayName}
          </span>
          {VERIFIED_PUBKEYS.has(pubkey) && <VerifiedBadge className="size-14 shrink-0" />}
          <span className="ml-auto shrink-0 text-[10px] text-text-2 opacity-60">
            {timeAgo(summary.lastMessage.createdAt)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-8">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              unread > 0 ? 'font-medium text-text' : 'text-text-2',
            )}
          >
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
}
