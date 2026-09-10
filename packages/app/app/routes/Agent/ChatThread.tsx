import type { CapabilityCard } from '@elisym/sdk';
import { useEffect, useRef } from 'react';
import type { PingStatus } from '~/hooks/usePingAgent';
import type { ChatThreadEntry } from '~/lib/chatThread';
import { onchainCardFor } from '~/lib/onchainCall';
import { ChatEntry } from './ChatEntry';
import { ChatRetryButton } from './ChatRetryButton';
import type { ChatSend } from './useChatSend';

interface Props {
  /** The selected chat's entries only (what this thread renders). */
  entries: ChatThreadEntry[];
  /**
   * The full identity-scoped thread - retry sends resolve their session
   * adoption candidates over ALL entries, not the selected chat's slice.
   */
  allEntries: ChatThreadEntry[];
  /**
   * Whether the sidebar already lists chats - an empty panel then means "a
   * draft new chat", not "no history at all", and the copy must not claim
   * there are no messages with this agent.
   */
  hasChats: boolean;
  agentPubkey: string;
  loading: boolean;
  cards: CapabilityCard[];
  pingStatus: PingStatus;
  buying: boolean;
  /** The in-flight job's id + live status line (from ActiveBuySession). */
  liveJobEventId: string | null;
  liveStatus: string | null;
  ratedIds: Set<string>;
  canRate: boolean;
  onRate: (entry: ChatThreadEntry, positive: boolean) => void;
  onOpen: (entry: ChatThreadEntry) => void;
  onSelectCardIndex: (index: number) => void;
  send: ChatSend;
  /** /jobs deep-link target: scroll this entry into view once. */
  focusJobEventId?: string | null;
}

interface ThreadItem {
  entry: ChatThreadEntry;
  /** Set when this entry opens a new day - rendered as a day chip above it. */
  dayLabel?: string;
  /** A conversation boundary between consecutive UUID-carrying entries. */
  sessionDivider: boolean;
}

function dayKeyOf(ts: number): string {
  return new Date(ts).toDateString();
}

function dayLabelFor(ts: number): string {
  const date = new Date(ts);
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

/**
 * Session-boundary dividers are derived over the subsequence of UUID-carrying
 * entries ONLY: `null` one-shots and absent (hydrated pre-feature) entries
 * never fabricate a boundary - [s1, s1, one-shot, s1] stays one conversation.
 */
function buildThreadItems(entries: ChatThreadEntry[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let lastUuidSession: string | undefined;
  let lastDayKey: string | undefined;
  for (const entry of entries) {
    const dayKey = dayKeyOf(entry.ts);
    const newDay = dayKey !== lastDayKey;
    lastDayKey = dayKey;
    let sessionDivider = false;
    if (typeof entry.sessionId === 'string') {
      sessionDivider = lastUuidSession !== undefined && entry.sessionId !== lastUuidSession;
      lastUuidSession = entry.sessionId;
    }
    items.push({
      entry,
      ...(newDay ? { dayLabel: dayLabelFor(entry.ts) } : {}),
      sessionDivider,
    });
  }
  return items;
}

function ChatThreadSkeleton() {
  return (
    <div className="flex flex-col gap-8 p-14">
      <div className="skeleton h-36 w-2/5 self-end rounded-16" />
      <div className="skeleton h-48 w-3/5 self-start rounded-16" />
      <div className="skeleton h-36 w-1/3 self-end rounded-16" />
      <div className="skeleton h-36 w-1/2 self-start rounded-16" />
    </div>
  );
}

export function ChatThread({
  entries,
  allEntries,
  hasChats,
  agentPubkey,
  loading,
  cards,
  pingStatus,
  buying,
  liveJobEventId,
  liveStatus,
  ratedIds,
  canRate,
  onRate,
  onOpen,
  onSelectCardIndex,
  send,
  focusJobEventId,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastEntryId = entries.length > 0 ? entries[entries.length - 1]?.jobEventId : undefined;

  // Auto-scroll to the newest message (the messenger pattern) whenever the
  // thread grows or the newest entry changes state - suspended while a
  // deep-link focus is active, or hydration finishing after the focus scroll
  // would yank the viewport away from the entry the user came to read. The
  // parent releases the focus on a manual chat switch or a live send, which
  // resumes the normal scroll.
  useEffect(() => {
    if (focusJobEventId) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length, lastEntryId, focusJobEventId]);

  // /jobs deep-link: scroll the focused entry into view. Handled once per
  // id - the scroll must not re-fire on every entries change. Deliberately
  // scroll-only: an entry highlight was tried and removed by design.
  const handledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusJobEventId || handledFocusRef.current === focusJobEventId) {
      return;
    }
    const target = scrollRef.current?.querySelector(`[data-job-id="${focusJobEventId}"]`);
    if (!(target instanceof HTMLElement)) {
      return;
    }
    handledFocusRef.current = focusJobEventId;
    target.scrollIntoView({ block: 'center' });
  }, [focusJobEventId, entries]);

  if (loading && entries.length === 0) {
    return <ChatThreadSkeleton />;
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-16 py-56">
        <p className="m-0 text-sm text-text-2">{hasChats ? 'New chat' : 'No messages yet'}</p>
        <p className="m-0 mt-4 text-center text-sm text-text-2/60">
          {hasChats
            ? 'Write your message below to start it'
            : 'Your chats with this agent will appear in the chat list'}
        </p>
      </div>
    );
  }

  const items = buildThreadItems(entries);

  return (
    <div ref={scrollRef} className="flex max-h-[65vh] flex-col gap-16 overflow-y-auto p-2 sm:p-6">
      {items.map(({ entry, dayLabel, sessionDivider }) => (
        <div key={entry.jobEventId} className="flex flex-col gap-8">
          {dayLabel && (
            <div className="mt-4 mb-2 flex items-center justify-center">
              <span className="rounded-full bg-surface-2 px-10 py-3 text-[10px] font-medium text-text-2">
                {dayLabel}
              </span>
            </div>
          )}
          {sessionDivider && (
            <div className="my-4 flex items-center gap-10">
              <span className="h-px flex-1 bg-black/6" />
              <span className="text-[10px] font-medium tracking-wide text-text-2/70 uppercase">
                New conversation
              </span>
              <span className="h-px flex-1 bg-black/6" />
            </div>
          )}
          <div data-job-id={entry.jobEventId}>
            <ChatEntry
              entry={entry}
              agentPubkey={agentPubkey}
              onchainCard={onchainCardFor(cards, entry.capability)}
              liveStatus={entry.jobEventId === liveJobEventId ? liveStatus : null}
              rated={ratedIds.has(entry.jobEventId)}
              canRate={canRate && entry.capability !== ''}
              onRate={(positive) => onRate(entry, positive)}
              onOpen={() => onOpen(entry)}
              retryNode={
                entry.status === 'failed' ? (
                  <ChatRetryButton
                    entry={entry}
                    cards={cards}
                    agentPubkey={agentPubkey}
                    pingStatus={pingStatus}
                    buying={buying}
                    entries={allEntries}
                    onSelectCardIndex={onSelectCardIndex}
                    send={send}
                  />
                ) : undefined
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}
