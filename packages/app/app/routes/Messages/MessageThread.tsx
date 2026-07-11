import { truncateKey } from '@elisym/sdk';
import type { DirectMessage } from '@elisym/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { VerifiedBadge } from '~/components/VerifiedBadge';
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

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MessageThread({ counterpartPubkey }: Props) {
  const { client } = useElisymClient();
  const { identity, publicKey } = useIdentity();
  const queryClient = useQueryClient();
  const { data: messages, isLoading } = useThread(counterpartPubkey);
  const messageList = messages ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
        <div className="size-28 shrink-0 overflow-hidden rounded-full">
          <MarbleAvatar name={counterpartPubkey} size={28} />
        </div>
        <Link
          to={`/agent/${counterpartPubkey}`}
          className="truncate font-mono text-xs font-medium text-text no-underline hover:underline"
        >
          {truncateKey(nip19.npubEncode(counterpartPubkey), 8)}
        </Link>
        {VERIFIED_PUBKEYS.has(counterpartPubkey) && <VerifiedBadge className="size-14 shrink-0" />}
      </div>

      <div ref={scrollRef} className="flex max-h-[60vh] flex-1 flex-col gap-8 overflow-y-auto p-14">
        {isLoading && messageList.length === 0 && (
          <p className="text-sm text-text-2">Loading messages…</p>
        )}
        {!isLoading && messageList.length === 0 && (
          <p className="text-sm text-text-2">
            No messages yet. Say hello - messages are end-to-end encrypted.
          </p>
        )}
        {messageList.map((message) => (
          <div
            key={message.id}
            className={cn('flex flex-col', message.isMine ? 'items-end' : 'items-start')}
          >
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
            <span className="mt-2 text-[10px] text-text-2 opacity-60">
              {formatTime(message.createdAt)}
            </span>
          </div>
        ))}
      </div>

      <MessageComposer onSend={handleSend} />
    </div>
  );
}
