import { truncateKey } from '@elisym/sdk';
import type { DirectMessage } from '@elisym/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
import { useAgent } from '~/hooks/useAgent';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { mergeMessages, threadQueryKey, useThread } from '~/hooks/useMessages';
import { cn } from '~/lib/cn';
import { advanceReadCursor } from '~/lib/readCursors';
import { VERIFIED_PUBKEYS } from '~/lib/verified';
import { MessageComposer } from './MessageComposer';

interface Props {
  counterpartPubkey: string;
}

/** Consecutive same-sender messages within this gap render as one visual group. */
const GROUP_GAP_SECS = 300;

interface ThreadItem {
  message: DirectMessage;
  /** Set when this message opens a new day - rendered as a day chip above it. */
  dayLabel?: string;
  groupStart: boolean;
  /** Timestamps render only on the last message of a group. */
  groupEnd: boolean;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function dayKeyOf(createdAt: number): string {
  return new Date(createdAt * 1000).toDateString();
}

function dayLabelFor(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildThreadItems(messages: DirectMessage[]): ThreadItem[] {
  return messages.map((message, index) => {
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const newDay = !prev || dayKeyOf(prev.createdAt) !== dayKeyOf(message.createdAt);
    const groupStart =
      newDay ||
      !prev ||
      prev.isMine !== message.isMine ||
      message.createdAt - prev.createdAt > GROUP_GAP_SECS;
    const groupEnd =
      !next ||
      dayKeyOf(next.createdAt) !== dayKeyOf(message.createdAt) ||
      next.isMine !== message.isMine ||
      next.createdAt - message.createdAt > GROUP_GAP_SECS;
    return {
      message,
      dayLabel: newDay ? dayLabelFor(message.createdAt) : undefined,
      groupStart,
      groupEnd,
    };
  });
}

export function MessageThread({ counterpartPubkey }: Props) {
  const { client } = useElisymClient();
  const { identity, publicKey } = useIdentity();
  const queryClient = useQueryClient();
  const { data: messages, isLoading } = useThread(counterpartPubkey);
  const { agent } = useAgent(counterpartPubkey);
  const [imgError, setImgError] = useState(false);
  const messageList = messages ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const npub = nip19.npubEncode(counterpartPubkey);
  const displayName = agent?.name?.trim() || truncateKey(npub, 8);

  // Mark read while the thread is open: on open and as messages arrive.
  useEffect(() => {
    if (!messages || messages.length === 0) {
      return;
    }
    const maxSeen = messages.reduce((max, message) => Math.max(max, message.createdAt), 0);
    advanceReadCursor(publicKey, counterpartPubkey, maxSeen);
  }, [messages, publicKey, counterpartPubkey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function handleSend(content: string) {
    const { id } = await client.messages.send(identity, counterpartPubkey, content);
    const sent: DirectMessage = {
      id,
      senderPubkey: publicKey,
      recipientPubkey: counterpartPubkey,
      content,
      createdAt: nowSecs(),
      isMine: true,
    };
    queryClient.setQueryData<DirectMessage[]>(
      threadQueryKey(publicKey, counterpartPubkey),
      (existing) => mergeMessages(existing, [sent]),
    );
  }

  const threadItems = buildThreadItems(messageList);

  return (
    <div className="flex min-h-480 flex-col overflow-hidden rounded-2xl border border-black/7 bg-surface">
      <div className="flex items-center gap-10 border-b border-black/5 px-14 py-10">
        <Link
          to="/messages"
          className="mr-2 inline-flex size-24 shrink-0 items-center justify-center rounded-full text-text-2 no-underline transition-colors hover:bg-black/5 md:hidden"
          aria-label="Back to conversations"
        >
          <svg
            aria-hidden
            className="size-14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 6 9 12 15 18" />
          </svg>
        </Link>
        <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-full">
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
            <MarbleAvatar name={counterpartPubkey} size={32} />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-4">
            <Link
              to={`/agent/${counterpartPubkey}`}
              title="View agent page"
              className={cn(
                'truncate text-xs font-semibold text-text no-underline hover:underline',
                !agent?.name && 'font-mono',
              )}
            >
              {displayName}
            </Link>
            {VERIFIED_PUBKEYS.has(counterpartPubkey) && (
              <VerifiedBadge className="size-14 shrink-0" />
            )}
          </div>
          {agent?.name && (
            <div className="truncate font-mono text-[10px] text-text-2 opacity-60" title={npub}>
              {truncateKey(npub, 8)}
            </div>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex max-h-[60vh] flex-1 flex-col gap-2 overflow-y-auto p-14">
        {isLoading && messageList.length === 0 && (
          <div className="flex flex-col gap-8">
            <div className="skeleton h-36 w-3/5 self-start rounded-16" />
            <div className="skeleton h-36 w-2/5 self-end rounded-16" />
            <div className="skeleton h-36 w-1/2 self-start rounded-16" />
          </div>
        )}
        {!isLoading && messageList.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-10 text-center">
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
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <p className="text-sm font-medium text-text">No messages yet</p>
            <p className="text-xs text-text-2">Say hello - messages are end-to-end encrypted.</p>
          </div>
        )}
        {threadItems.map(({ message, dayLabel, groupStart, groupEnd }) => (
          <div key={message.id} className={cn(groupStart && 'mt-8')}>
            {dayLabel && (
              <div className="mt-4 mb-10 flex items-center justify-center">
                <span className="rounded-full bg-surface-2 px-10 py-3 text-[10px] font-medium text-text-2">
                  {dayLabel}
                </span>
              </div>
            )}
            <div className={cn('flex flex-col', message.isMine ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-16 px-12 py-8 text-sm sm:max-w-[70%]',
                  message.isMine ? 'bg-surface-dark text-white' : 'bg-surface-2 text-text',
                )}
              >
                {/* Remote content is untrusted: plain text only, no markdown,
                    no HTML, no auto-linking. */}
                <p className="break-words whitespace-pre-wrap">{message.content}</p>
              </div>
              {groupEnd && (
                <span className="mt-2 text-[10px] text-text-2 opacity-60">
                  {formatTime(message.createdAt)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <MessageComposer onSend={handleSend} />
    </div>
  );
}
