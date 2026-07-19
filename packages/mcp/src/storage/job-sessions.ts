/**
 * Customer-side job-session bookkeeping: which conversation (session id) this
 * agent holds with which provider. Load-bearing for auto mode - it is how the
 * MCP knows an ongoing conversation exists and should ask before continuing it.
 *
 * The session -> jobs mapping lives HERE (`jobIds`), deliberately NOT as a new
 * field on `CustomerJobEntry`: `.customer-history.json` is `.strict()` and its
 * reader discards the whole document when any entry fails parse, so adding a
 * field there would make a rollback to an older MCP silently wipe the user's
 * entire history. A brand-new file is downgrade-safe by construction.
 *
 * Persistent agents (agentDir set) use `.job-sessions.json` (same discipline as
 * `.customer-history.json`: atomic write 0o600, per-path lock, corrupt -> empty).
 * Ephemeral agents keep a process-lifetime in-memory registry keyed by the
 * agent's identity pubkey - `switch_agent` must never gate one agent's submits
 * on another agent's sessions - so the continue-gate still works within one
 * host session; nothing survives restart (a restart auto-starts fresh, which is
 * bleed-free).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureGitignoreHasJobSessionsEntry, writeFileAtomic } from '@elisym/sdk/agent-store';
import { z } from 'zod';
import { sanitizeField } from '../sanitize.js';

export const JOB_SESSIONS_FILENAME = '.job-sessions.json';
export const MAX_SESSION_ENTRIES = 200;
export const MAX_JOB_IDS_PER_SESSION = 100;
export const FIRST_PROMPT_MAX_LEN = 200;

/**
 * A session is "live" (offered for continuation) only while the provider still
 * holds its transcript: the provider-side TTL is 30 days, so stop offering at
 * 25 - a session the provider already forgot would misattribute context.
 */
export const SESSION_LIVENESS_MS = 25 * 24 * 60 * 60 * 1000;

const SESSION_ID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const JobSessionEntrySchema = z
  .object({
    sessionId: z.string().regex(SESSION_ID_V4_REGEX),
    providerPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    providerName: z.string().max(200).optional(),
    capability: z.string().min(1).max(200),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative(),
    /** Completed exchanges only - never asserts provider-side state a failed job would falsify. */
    turnCount: z.number().int().nonnegative(),
    /** sanitizeField'd + clipped at write time - can be third-party content (diffs, files). */
    firstPrompt: z.string().max(FIRST_PROMPT_MAX_LEN),
    /** Event ids of this session's submits, newest-last, capped. */
    jobIds: z.array(z.string().min(1).max(128)).max(MAX_JOB_IDS_PER_SESSION),
  })
  .strict();

export const JobSessionsSchema = z
  .object({
    version: z.literal(1),
    sessions: z.array(JobSessionEntrySchema),
  })
  .strict();

export type JobSessionEntry = z.infer<typeof JobSessionEntrySchema>;
export type JobSessions = z.infer<typeof JobSessionsSchema>;

/**
 * Where this agent's sessions live: file-backed when `agentDir` is set,
 * otherwise the in-memory registry slot for `identityPubkey`.
 */
export interface SessionStoreHandle {
  agentDir?: string;
  identityPubkey: string;
}

const EMPTY: JobSessions = { version: 1, sessions: [] };

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const wrapped = next.finally(() => {
    if (writeLocks.get(key) === wrapped) {
      writeLocks.delete(key);
    }
  });
  writeLocks.set(key, wrapped);
  return next;
}

/** Process-lifetime registry for ephemeral agents, keyed by identity pubkey. */
const inMemoryRegistry = new Map<string, JobSessions>();

/** Test-only: wipe the ephemeral registry between test cases. */
export function clearInMemorySessions(): void {
  inMemoryRegistry.clear();
}

function pathFor(agentDir: string): string {
  return join(agentDir, JOB_SESSIONS_FILENAME);
}

function lockKeyFor(handle: SessionStoreHandle): string {
  return handle.agentDir !== undefined ? pathFor(handle.agentDir) : `mem:${handle.identityPubkey}`;
}

async function readSessions(handle: SessionStoreHandle): Promise<JobSessions> {
  if (handle.agentDir === undefined) {
    const existing = inMemoryRegistry.get(handle.identityPubkey);
    // Deep-copy so callers can mutate freely before writeSessions, mirroring
    // the file path where every read parses a fresh object.
    return existing
      ? (JSON.parse(JSON.stringify(existing)) as JobSessions)
      : { ...EMPTY, sessions: [] };
  }
  let raw: string;
  try {
    raw = await readFile(pathFor(handle.agentDir), 'utf-8');
  } catch {
    return { ...EMPTY, sessions: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const result = JobSessionsSchema.safeParse(parsed);
    return result.success ? result.data : { ...EMPTY, sessions: [] };
  } catch {
    return { ...EMPTY, sessions: [] };
  }
}

async function writeSessions(handle: SessionStoreHandle, sessions: JobSessions): Promise<void> {
  if (handle.agentDir === undefined) {
    inMemoryRegistry.set(handle.identityPubkey, sessions);
    return;
  }
  // Gitignore migration before the first write, same as the read-cursors store:
  // the file maps who the agent converses with and holds first-prompt clips.
  await ensureGitignoreHasJobSessionsEntry(dirname(handle.agentDir));
  const body = JSON.stringify(sessions, null, 2) + '\n';
  await writeFileAtomic(pathFor(handle.agentDir), body, 0o600);
}

/**
 * First-prompt clip recorded at session creation. Sanitized here (write-side)
 * because for from-file/diff submits the "first message" is routinely
 * third-party content; empty inputs (spilled text, file jobs with no note)
 * fall back to a placeholder so the continue-gate never shows an empty quote.
 */
export function buildFirstPrompt(
  input: string,
  attachmentName?: string,
  capability?: string,
): string {
  const trimmed = input.trim();
  if (trimmed.length > 0) {
    return sanitizeField(trimmed, FIRST_PROMPT_MAX_LEN);
  }
  if (attachmentName !== undefined && attachmentName.length > 0) {
    return sanitizeField(`[file: ${attachmentName}]`, FIRST_PROMPT_MAX_LEN);
  }
  return sanitizeField(`[${capability ?? 'job'}]`, FIRST_PROMPT_MAX_LEN);
}

export interface RecordSessionSubmitOptions {
  sessionId: string;
  providerPubkey: string;
  providerName?: string;
  capability: string;
  /** Already built via buildFirstPrompt - only used when the entry is created. */
  firstPrompt: string;
  jobEventId: string;
}

/**
 * Record a session-carrying submit: create the entry if absent (turnCount 0),
 * bump `lastUsedAt`, append the job id (capped, newest-last), update the last
 * capability. LRU-trims oldest sessions past MAX_SESSION_ENTRIES.
 */
export async function recordSessionSubmit(
  handle: SessionStoreHandle,
  options: RecordSessionSubmitOptions,
): Promise<void> {
  return withLock(lockKeyFor(handle), async () => {
    const store = await readSessions(handle);
    const now = Date.now();
    let entry = store.sessions.find((session) => session.sessionId === options.sessionId);
    if (!entry) {
      entry = {
        sessionId: options.sessionId,
        providerPubkey: options.providerPubkey,
        providerName: options.providerName,
        capability: options.capability,
        createdAt: now,
        lastUsedAt: now,
        turnCount: 0,
        firstPrompt: options.firstPrompt,
        jobIds: [],
      };
      store.sessions.push(entry);
    }
    entry.lastUsedAt = now;
    entry.capability = options.capability;
    if (!entry.jobIds.includes(options.jobEventId)) {
      entry.jobIds.push(options.jobEventId);
      if (entry.jobIds.length > MAX_JOB_IDS_PER_SESSION) {
        entry.jobIds.splice(0, entry.jobIds.length - MAX_JOB_IDS_PER_SESSION);
      }
    }
    if (store.sessions.length > MAX_SESSION_ENTRIES) {
      store.sessions.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
      store.sessions.splice(0, store.sessions.length - MAX_SESSION_ENTRIES);
    }
    // Validate before write, same rationale as appendCustomerJob: the reader
    // discards the whole document when any entry fails parse.
    const validated = JobSessionsSchema.parse(store);
    await writeSessions(handle, validated);
  });
}

/** Increment a session's completed-exchange count. No-op for unknown ids. */
export async function bumpSessionTurnCount(
  handle: SessionStoreHandle,
  sessionId: string,
): Promise<void> {
  return withLock(lockKeyFor(handle), async () => {
    const store = await readSessions(handle);
    const entry = store.sessions.find((session) => session.sessionId === sessionId);
    if (!entry) {
      return;
    }
    entry.turnCount += 1;
    await writeSessions(handle, store);
  });
}

/**
 * Newest live session with a provider (for the auto-mode continue-gate).
 * "Live" = lastUsedAt within SESSION_LIVENESS_MS; older entries are treated
 * as absent - the provider's 30-day TTL has likely reclaimed them.
 */
export async function findLiveSession(
  handle: SessionStoreHandle,
  providerPubkey: string,
): Promise<JobSessionEntry | undefined> {
  const store = await readSessions(handle);
  const cutoff = Date.now() - SESSION_LIVENESS_MS;
  return store.sessions
    .filter((session) => session.providerPubkey === providerPubkey && session.lastUsedAt >= cutoff)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0];
}

/** Look up a session by id (for the provider-mismatch guard and explicit continues). */
export async function findSessionById(
  handle: SessionStoreHandle,
  sessionId: string,
): Promise<JobSessionEntry | undefined> {
  const store = await readSessions(handle);
  return store.sessions.find((session) => session.sessionId === sessionId);
}

/** Reverse lookup: which session (if any) a job event id belongs to. */
export async function findSessionByJobId(
  handle: SessionStoreHandle,
  jobEventId: string,
): Promise<JobSessionEntry | undefined> {
  const store = await readSessions(handle);
  return store.sessions.find((session) => session.jobIds.includes(jobEventId));
}

/** All sessions, newest-first by lastUsedAt, capped at `limit`. */
export async function listJobSessions(
  handle: SessionStoreHandle,
  limit: number,
): Promise<JobSessionEntry[]> {
  const store = await readSessions(handle);
  return store.sessions.sort((left, right) => right.lastUsedAt - left.lastUsedAt).slice(0, limit);
}
