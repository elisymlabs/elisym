/**
 * Sidebar chat grouping (`routes/Agent/lib/chatList.ts`): one item per
 * conversation session, one per one-shot (null AND absent alike), newest-first
 * ordering, key stability, and title derivation.
 */
import { describe, expect, it } from 'vitest';
import type { ChatThreadEntry } from '../app/lib/chatThread';
import {
  buildChatList,
  chatKeyOf,
  chatTitleOf,
  NEW_CHAT_KEY,
} from '../app/routes/Agent/lib/chatList';

const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function entry(overrides: Partial<ChatThreadEntry> & { jobEventId: string }): ChatThreadEntry {
  return {
    customerPubkey: 'identity-a',
    capability: 'echo',
    prompt: '',
    ts: 0,
    ...overrides,
  };
}

describe('chatKeyOf', () => {
  it('keys UUID entries by session and null/absent entries by job id', () => {
    expect(chatKeyOf(entry({ jobEventId: 'j1', sessionId: SESSION_A }))).toBe(
      `session:${SESSION_A}`,
    );
    expect(chatKeyOf(entry({ jobEventId: 'j2', sessionId: null }))).toBe('job:j2');
    expect(chatKeyOf(entry({ jobEventId: 'j3' }))).toBe('job:j3');
  });

  it('never collides with the draft sentinel', () => {
    expect(chatKeyOf(entry({ jobEventId: NEW_CHAT_KEY }))).not.toBe(NEW_CHAT_KEY);
  });
});

describe('buildChatList', () => {
  it('groups session entries and splits one-shots (null and absent alike)', () => {
    const items = buildChatList([
      entry({ jobEventId: 'j1', sessionId: SESSION_A, ts: 100 }),
      entry({ jobEventId: 'j2', sessionId: null, ts: 200 }),
      entry({ jobEventId: 'j3', sessionId: SESSION_A, ts: 300 }),
      entry({ jobEventId: 'j4', ts: 400 }),
    ]);
    expect(items.map((item) => item.key)).toEqual(['job:j4', `session:${SESSION_A}`, 'job:j2']);
    const session = items.find((item) => item.key === `session:${SESSION_A}`);
    expect(session?.kind).toBe('session');
    expect(session?.sessionId).toBe(SESSION_A);
    expect(session?.entries.map((chatEntry) => chatEntry.jobEventId)).toEqual(['j1', 'j3']);
    expect(session?.lastTs).toBe(300);
    expect(items.find((item) => item.key === 'job:j4')?.kind).toBe('oneshot');
  });

  it('orders chats newest-first by their last entry', () => {
    const items = buildChatList([
      entry({ jobEventId: 'j1', sessionId: SESSION_A, ts: 100 }),
      entry({ jobEventId: 'j2', sessionId: SESSION_B, ts: 150 }),
      entry({ jobEventId: 'j3', sessionId: SESSION_A, ts: 500 }),
    ]);
    expect(items.map((item) => item.key)).toEqual([`session:${SESSION_A}`, `session:${SESSION_B}`]);
  });

  it('returns an empty list for no entries', () => {
    expect(buildChatList([])).toEqual([]);
  });
});

describe('chatTitleOf', () => {
  it('uses the first non-empty prompt, else the fallback', () => {
    const withPrompt = buildChatList([
      entry({ jobEventId: 'j1', sessionId: SESSION_A, ts: 100, prompt: '  hello there  ' }),
    ]);
    const first = withPrompt[0];
    expect(first !== undefined && chatTitleOf(first, 'Echo')).toBe('hello there');

    const promptless = buildChatList([entry({ jobEventId: 'j2', ts: 100, prompt: '   ' })]);
    const second = promptless[0];
    expect(second !== undefined && chatTitleOf(second, 'Echo')).toBe('Echo');
  });
});
