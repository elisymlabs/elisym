import type { ChatThreadEntry } from '~/lib/chatThread';

export type ChatKind = 'session' | 'oneshot';

export interface ChatListItem {
  /** `session:<uuid>` for conversations, `job:<jobEventId>` for one-shots. */
  key: string;
  kind: ChatKind;
  /** Set for `kind: 'session'` only. */
  sessionId?: string;
  /** The chat's entries, in the input's (ts-ascending) order. */
  entries: ChatThreadEntry[];
  lastTs: number;
}

/** Sidebar selection sentinel for the not-yet-sent draft chat. */
export const NEW_CHAT_KEY = 'new';

export function chatKeyOf(entry: ChatThreadEntry): string {
  return typeof entry.sessionId === 'string'
    ? `session:${entry.sessionId}`
    : `job:${entry.jobEventId}`;
}

/**
 * Group identity-scoped, ts-sorted thread entries into sidebar chat items:
 * one item per conversation session (UUID-carrying entries share it), one
 * item per stateless one-shot (`null` send-path markers AND absent hydrated
 * entries alike - neither participates in a conversation). Newest first.
 */
export function buildChatList(entries: ChatThreadEntry[]): ChatListItem[] {
  const byKey = new Map<string, ChatListItem>();
  for (const entry of entries) {
    const key = chatKeyOf(entry);
    const existing = byKey.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.lastTs = Math.max(existing.lastTs, entry.ts);
      continue;
    }
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
    byKey.set(key, {
      key,
      kind: sessionId !== undefined ? 'session' : 'oneshot',
      ...(sessionId !== undefined ? { sessionId } : {}),
      entries: [entry],
      lastTs: entry.ts,
    });
  }
  return [...byKey.values()].sort((left, right) => right.lastTs - left.lastTs);
}

/** The chat's display title: the first non-empty prompt, else the fallback. */
export function chatTitleOf(item: ChatListItem, fallback: string): string {
  const firstPrompt = item.entries.find((entry) => entry.prompt.trim() !== '')?.prompt;
  return firstPrompt !== undefined && firstPrompt.trim() !== '' ? firstPrompt.trim() : fallback;
}
