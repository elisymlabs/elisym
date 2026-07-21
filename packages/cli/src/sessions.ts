/**
 * SessionStore - provider-side conversation sessions for NIP-90 jobs.
 *
 * A session is an append-only JSONL transcript at
 * `<agentDir>/.sessions/<customerPubkey>/<sessionId>.jsonl`. The customer-pubkey
 * namespace is a security boundary: the pubkey comes from the signature-verified
 * request event, so a session id can never be read or extended across customers.
 *
 * All filesystem operations in this module are SYNCHRONOUS on purpose. Every
 * eligibility check here (mutex try-acquire, admitted-count, TTL, caps) is
 * check-then-act; keeping check and act inside one synchronous block means no
 * event-loop yield can interleave a competing job between them. Files are small
 * (per-turn and per-file caps below) and the sweeps are hourly, so blocking the
 * loop briefly is a fair trade for race-freedom.
 *
 * Single-process assumption: the mutex, admitted counter, and byte counter are
 * in-process. One `elisym start` per agent dir (same posture as the job ledger).
 *
 * Design doc: docs/plans/job-conversation-context.md (§2, §3, §4, §5).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SESSION_ID_REGEX } from '@elisym/sdk';
import type { ChatTurn } from '@elisym/sdk/skills';

/** Directory name under the agent dir. Gitignored (cleartext customer content). */
export const SESSIONS_DIR_NAME = '.sessions';

/** Max concurrently admitted jobs per (customer, session) - intake "session busy" cap. */
export const SESSION_MAX_CONCURRENT_JOBS = 2;
/** Session TTL by last activity. Matches the job ledger's 30-day retention. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Max sessions per customer; oldest idle is LRU-evicted to admit a new one. */
export const SESSION_MAX_PER_CUSTOMER = 64;
/** Max stored bytes per turn; longer content is truncated with a marker. */
export const SESSION_MAX_TURN_BYTES = 256 * 1024;
/** Per-file backstop - compaction keeps files far smaller; over it = corrupt. */
export const SESSION_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Global byte cap across all sessions; counts new sessions and appends alike. */
export const SESSION_GLOBAL_MAX_BYTES = 512 * 1024 * 1024;
/** At-cap global eviction drains usage below this high-water mark. */
export const SESSION_GLOBAL_EVICT_TO_BYTES = Math.floor(SESSION_GLOBAL_MAX_BYTES * 0.9);
/** Compaction trigger on the replayed history size (chars ~ tokens/4 heuristic). */
export const SESSION_COMPACTION_TRIGGER_CHARS = 120_000;
/** Kept tail budget: longest turn suffix whose combined size stays under this. */
export const SESSION_COMPACTION_KEEP_CHARS = Math.floor(SESSION_COMPACTION_TRIGGER_CHARS / 2);
/** Consecutive compaction failures before the no-summary force-truncate escape hatch. */
export const SESSION_COMPACTION_MAX_STRIKES = 2;

/** Fixed marker prefix for the summary's replay representation (a user-role message). */
export const SESSION_SUMMARY_PREFIX = '[Conversation summary]';
/** Summary content written by the force-truncate escape hatch. */
export const SESSION_CONTEXT_UNAVAILABLE = '[earlier context unavailable]';
/** Marker appended when stored turn content hits the per-turn byte cap. */
const TRUNCATION_MARKER = '\n[truncated]';

const CUSTOMER_PUBKEY_REGEX = /^[0-9a-f]{64}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface TurnLine {
  type: 'turn';
  role: 'user' | 'assistant';
  content: string;
  jobId: string;
  capability?: string;
  ts: number;
}

interface SummaryLine {
  type: 'summary';
  content: string;
  ts: number;
}

type SessionLine = TurnLine | SummaryLine;

/** Result of opening a session under its mutex, before skill execution. */
export interface OpenedSession {
  /**
   * True when a storage cap left no room to record this session (global cap
   * with no evictable victim, or per-customer cap with all sessions in
   * flight). The job must run without history and without appending.
   */
  stateless: boolean;
  /** Whether the transcript existed on disk (false = fresh or expired-reset). */
  known: boolean;
  /** Replayed history for the LLM. Empty array when none survives assembly. */
  messages: ChatTurn[];
  /** True when the replayed history exceeds the compaction trigger. */
  compactionNeeded: boolean;
  /** Flattened text of the turns a compaction would summarize (trigger only). */
  summarizeText?: string;
  /**
   * Roles already recorded for the opened job's `excludeJobId` (crash-recovery
   * re-execution). `appendExchange` skips these - dedupe by `(jobId, role)`.
   */
  recordedRoles: ReadonlySet<'user' | 'assistant'>;
}

export interface SessionExchange {
  jobId: string;
  capability: string;
  userContent: string;
  assistantContent: string;
  /** Roles NOT to append (already present - from `OpenedSession.recordedRoles`). */
  skipRoles?: ReadonlySet<'user' | 'assistant'>;
}

export interface RecoverySessionRef {
  jobId: string;
  customerId: string;
  sessionId: string;
}

export interface SessionStoreLogger {
  (message: string): void;
}

interface AdmittedEntry {
  live: number;
  recovery: Set<string>;
}

/**
 * Test-only tuning of the store limits. Production always runs the module
 * constants (deliberately NOT operator config - YAGNI per the design doc);
 * this exists because the byte/TTL caps are impractical to exercise at their
 * real values in tests.
 */
export interface SessionStoreTuning {
  ttlMs?: number;
  maxPerCustomer?: number;
  maxTurnBytes?: number;
  maxFileBytes?: number;
  globalMaxBytes?: number;
  globalEvictToBytes?: number;
  compactionTriggerChars?: number;
  compactionKeepChars?: number;
}

export class SessionStore {
  private readonly root: string;
  private readonly log: SessionStoreLogger;
  private readonly ttlMs: number;
  private readonly maxPerCustomer: number;
  private readonly maxTurnBytes: number;
  private readonly maxFileBytes: number;
  private readonly globalMaxBytes: number;
  private readonly globalEvictToBytes: number;
  private readonly compactionTriggerChars: number;
  private readonly compactionKeepChars: number;
  /** Session-key -> release promise. Entry present = mutex held. */
  private locks = new Map<string, { promise: Promise<void>; release: () => void }>();
  /** Session-key -> admitted-job counts (live intake + jobId-keyed recovery). */
  private admitted = new Map<string, AdmittedEntry>();
  /** Recovery registration index: jobId -> session key (for the release sweep). */
  private recoveryByJob = new Map<string, string>();
  /** Session-key -> consecutive compaction failures (in-process, reset on restart). */
  private compactionStrikes = new Map<string, number>();
  /** Running total of session-file bytes (established by `init()`'s scan). */
  private globalBytes = 0;

  constructor(agentDir: string, logger?: SessionStoreLogger, tuning?: SessionStoreTuning) {
    this.root = join(agentDir, SESSIONS_DIR_NAME);
    this.log = logger ?? (() => {});
    this.ttlMs = tuning?.ttlMs ?? SESSION_TTL_MS;
    this.maxPerCustomer = tuning?.maxPerCustomer ?? SESSION_MAX_PER_CUSTOMER;
    this.maxTurnBytes = tuning?.maxTurnBytes ?? SESSION_MAX_TURN_BYTES;
    this.maxFileBytes = tuning?.maxFileBytes ?? SESSION_MAX_FILE_BYTES;
    this.globalMaxBytes = tuning?.globalMaxBytes ?? SESSION_GLOBAL_MAX_BYTES;
    this.globalEvictToBytes =
      tuning?.globalEvictToBytes ??
      (tuning?.globalMaxBytes !== undefined
        ? Math.floor(tuning.globalMaxBytes * 0.9)
        : SESSION_GLOBAL_EVICT_TO_BYTES);
    this.compactionTriggerChars =
      tuning?.compactionTriggerChars ?? SESSION_COMPACTION_TRIGGER_CHARS;
    this.compactionKeepChars =
      tuning?.compactionKeepChars ??
      (tuning?.compactionTriggerChars !== undefined
        ? Math.floor(tuning.compactionTriggerChars / 2)
        : SESSION_COMPACTION_KEEP_CHARS);
  }

  /**
   * Startup: establish the global byte counter (excluding `.corrupt.*`
   * sidecars) and run a GC sweep. Call BEFORE `recoverPendingJobs` (mirrors
   * the ledger prune-before-recovery ordering).
   */
  init(): void {
    this.globalBytes = 0;
    for (const file of this.listSessionFiles()) {
      this.globalBytes += file.size;
    }
    this.gc();
  }

  /**
   * TTL sweep: delete sessions idle past the TTL and `.corrupt.*` sidecars
   * older than the TTL, then rmdir emptied customer dirs. A victim is deleted
   * only while holding its try-acquired mutex with a zero admitted count -
   * check and unlink are synchronous, so nothing can interleave.
   */
  gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const file of this.listSessionFiles()) {
      if (file.mtimeMs >= cutoff) {
        continue;
      }
      this.deleteIfIdle(file.customerId, file.sessionId);
    }
    this.pruneSidecars(cutoff);
    this.pruneEmptyCustomerDirs();
  }

  // ── Mutex ──────────────────────────────────────────────────────────────

  /**
   * Acquire the session mutex. Lock order invariant (runtime-enforced): the
   * caller already holds its `pLimit` slot - a mutex holder never waits for a
   * slot, so no lock-order inversion is possible.
   */
  async acquire(customerId: string, sessionId: string): Promise<() => void> {
    const key = sessionKey(customerId, sessionId);
    for (;;) {
      const current = this.locks.get(key);
      if (current === undefined) {
        return this.installLock(key);
      }
      await current.promise;
    }
  }

  /** Non-blocking acquire for GC/eviction. Returns a release fn or null. */
  private tryAcquireSync(key: string): (() => void) | null {
    if (this.locks.has(key)) {
      return null;
    }
    return this.installLock(key);
  }

  private installLock(key: string): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { promise, release };
    this.locks.set(key, entry);
    return () => {
      // Drop the map entry on release when it is still ours (bounded map);
      // waiters re-attempt and install a fresh entry.
      if (this.locks.get(key) === entry) {
        this.locks.delete(key);
      }
      entry.release();
    };
  }

  // ── Admitted-job counter ───────────────────────────────────────────────

  admittedCount(customerId: string, sessionId: string): number {
    const entry = this.admitted.get(sessionKey(customerId, sessionId));
    return entry === undefined ? 0 : entry.live + entry.recovery.size;
  }

  /** Live-intake registration. Pair with `releaseLive` in the job's finally. */
  admitLive(customerId: string, sessionId: string): void {
    const entry = this.admittedEntry(sessionKey(customerId, sessionId));
    entry.live++;
  }

  releaseLive(customerId: string, sessionId: string): void {
    const key = sessionKey(customerId, sessionId);
    const entry = this.admitted.get(key);
    if (entry === undefined) {
      return;
    }
    entry.live = Math.max(0, entry.live - 1);
    this.dropAdmittedIfEmpty(key, entry);
  }

  /**
   * Recovery pre-pass: register the sessions of pending `paid` entries (jobId-
   * keyed, idempotent across ticks) and release registrations whose ledger
   * entry has left `paid` (status predicate, re-checked every tick). Runs at
   * the top of every recovery tick, BEFORE its empty-pending early return -
   * releases are needed precisely when entries have left the pending set.
   */
  syncRecoveryRegistrations(
    refs: RecoverySessionRef[],
    isStillPaid: (jobId: string) => boolean,
  ): void {
    for (const ref of refs) {
      if (this.recoveryByJob.has(ref.jobId)) {
        continue;
      }
      const key = sessionKey(ref.customerId, ref.sessionId);
      this.recoveryByJob.set(ref.jobId, key);
      this.admittedEntry(key).recovery.add(ref.jobId);
    }
    for (const [jobId, key] of this.recoveryByJob) {
      if (isStillPaid(jobId)) {
        continue;
      }
      this.recoveryByJob.delete(jobId);
      const entry = this.admitted.get(key);
      if (entry !== undefined) {
        entry.recovery.delete(jobId);
        this.dropAdmittedIfEmpty(key, entry);
      }
    }
  }

  // ── Open / append / compaction (call with the session mutex held) ──────

  /**
   * Load the session for a job. Applies the load-time TTL check (expired file
   * is deleted BEFORE recording - expiry is a hard reset, never a resurrection),
   * the global byte cap (at-cap global LRU eviction, excluding this session),
   * and the per-customer LRU cap. `excludeJobId` (crash recovery) removes the
   * recovering job's own turns from the replayed history and reports which of
   * its roles are already recorded.
   */
  open(customerId: string, sessionId: string, excludeJobId?: string): OpenedSession {
    validateKeys(customerId, sessionId);
    const path = this.sessionPath(customerId, sessionId);
    const stateless: OpenedSession = {
      stateless: true,
      known: false,
      messages: [],
      compactionNeeded: false,
      recordedRoles: new Set(),
    };

    // Load-time TTL check: delete first, then treat as unknown (§5).
    let exists = existsSync(path);
    if (exists) {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > this.ttlMs) {
        this.deleteSessionFile(customerId, sessionId);
        exists = false;
        this.log(`[sessions] ${sessionId.slice(0, 8)} expired; starting fresh`);
      }
    }

    // Global cap: evict oldest unreserved sessions (never self) down to the
    // high-water mark; no eligible victim => stateless processing.
    if (this.globalBytes >= this.globalMaxBytes) {
      this.evictGlobal(sessionKey(customerId, sessionId));
      if (this.globalBytes >= this.globalMaxBytes) {
        this.log(
          '[sessions] global byte cap reached and no evictable victim; processing stateless',
        );
        return stateless;
      }
    }

    // Per-customer cap applies when this job would create a new session file.
    if (!exists && !this.ensureCustomerCapacity(customerId, sessionId)) {
      this.log(
        `[sessions] customer session cap reached with no evictable victim; processing stateless`,
      );
      return stateless;
    }

    if (!exists) {
      return {
        stateless: false,
        known: false,
        messages: [],
        compactionNeeded: false,
        recordedRoles: new Set(),
      };
    }

    const lines = this.readSessionLines(customerId, sessionId);
    if (lines === null) {
      // Corrupt (or over the 8 MiB backstop): sidecar-backed-up and reset.
      return {
        stateless: false,
        known: false,
        messages: [],
        compactionNeeded: false,
        recordedRoles: new Set(),
      };
    }

    const recordedRoles = new Set<'user' | 'assistant'>();
    if (excludeJobId !== undefined) {
      for (const line of lines) {
        if (line.type === 'turn' && line.jobId === excludeJobId) {
          recordedRoles.add(line.role);
        }
      }
    }

    const messages = assembleReplay(lines, excludeJobId);
    const replayedChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const compactionNeeded = replayedChars > this.compactionTriggerChars;

    return {
      stateless: false,
      known: true,
      messages,
      compactionNeeded,
      summarizeText: compactionNeeded
        ? buildSummarizeText(lines, this.keptTailStart(lines))
        : undefined,
      recordedRoles,
    };
  }

  /**
   * Record a completed exchange. Called after execution success, BEFORE the
   * ledger's `markExecuted` flush and before result seeding (§2 append timing).
   * Both turns go in one write; dedupe is `(jobId, role)` via `skipRoles`.
   */
  appendExchange(customerId: string, sessionId: string, exchange: SessionExchange): void {
    validateKeys(customerId, sessionId);
    const ts = Math.floor(Date.now() / 1000);
    const lines: TurnLine[] = [];
    if (!exchange.skipRoles?.has('user')) {
      lines.push({
        type: 'turn',
        role: 'user',
        content: truncateTurn(exchange.userContent, this.maxTurnBytes),
        jobId: exchange.jobId,
        capability: exchange.capability,
        ts,
      });
    }
    if (!exchange.skipRoles?.has('assistant')) {
      lines.push({
        type: 'turn',
        role: 'assistant',
        content: truncateTurn(exchange.assistantContent, this.maxTurnBytes),
        jobId: exchange.jobId,
        ts,
      });
    }
    if (lines.length === 0) {
      return;
    }
    const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const path = this.sessionPath(customerId, sessionId);
    try {
      appendFileSync(path, payload, { mode: FILE_MODE });
    } catch (error: unknown) {
      // The hourly sweep may have rmdir'd an emptied customer dir between this
      // job's open and its append; recreate and retry once.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      mkdirSync(join(this.root, customerId), { recursive: true, mode: DIR_MODE });
      appendFileSync(path, payload, { mode: FILE_MODE });
    }
    this.globalBytes += Buffer.byteLength(payload);
  }

  /**
   * Compaction rewrite: `[summary line, ...kept tail]`, atomic (temp + rename).
   * Returns the fresh replayed history. Throws on an empty summary - the
   * caller must treat that as a compaction failure, not rewrite on it (an
   * empty summary line is skipped at replay, silently vaporizing everything
   * it summarized).
   */
  compact(customerId: string, sessionId: string, summary: string): ChatTurn[] {
    if (summary.trim().length === 0) {
      throw new Error('empty summary');
    }
    const rewritten = this.rewriteWithSummary(customerId, sessionId, summary);
    this.compactionStrikes.delete(sessionKey(customerId, sessionId));
    return rewritten;
  }

  /**
   * Record a compaction failure (summarize error or empty summary). After
   * `SESSION_COMPACTION_MAX_STRIKES` consecutive failures, force-truncate
   * without a summarize call - same canonical `[summary, ...kept tail]` shape
   * with the fixed `[earlier context unavailable]` content - so a small-window
   * model can never permanently brick a session into paid-job failures.
   */
  compactionFailed(
    customerId: string,
    sessionId: string,
  ): { forced: boolean; messages?: ChatTurn[] } {
    const key = sessionKey(customerId, sessionId);
    const strikes = (this.compactionStrikes.get(key) ?? 0) + 1;
    if (strikes < SESSION_COMPACTION_MAX_STRIKES) {
      this.compactionStrikes.set(key, strikes);
      return { forced: false };
    }
    this.compactionStrikes.delete(key);
    const messages = this.rewriteWithSummary(customerId, sessionId, SESSION_CONTEXT_UNAVAILABLE);
    this.log(
      `[sessions] ${sessionId.slice(0, 8)} force-truncated after repeated compaction failures`,
    );
    return { forced: true, messages };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private admittedEntry(key: string): AdmittedEntry {
    let entry = this.admitted.get(key);
    if (entry === undefined) {
      entry = { live: 0, recovery: new Set() };
      this.admitted.set(key, entry);
    }
    return entry;
  }

  private dropAdmittedIfEmpty(key: string, entry: AdmittedEntry): void {
    if (entry.live === 0 && entry.recovery.size === 0) {
      this.admitted.delete(key);
    }
  }

  private sessionPath(customerId: string, sessionId: string): string {
    return join(this.root, customerId, `${sessionId}.jsonl`);
  }

  /**
   * Parse the transcript. A torn LAST line (crash mid-append) is dropped AND
   * repaired away: the file is atomically rewritten without it, because a
   * later `appendFileSync` would otherwise glue its first line onto the torn
   * fragment (the fragment has no trailing newline), corrupting a mid-file
   * line. Any other malformed line - or a file over the backstop - is treated
   * as corruption: the file is renamed to a `.corrupt.<ts>` sidecar (outside
   * the byte counter, pruned by the TTL sweep) and the session starts fresh.
   * Callers hold the session mutex, so the repair cannot race an append.
   */
  private readSessionLines(customerId: string, sessionId: string): SessionLine[] | null {
    const path = this.sessionPath(customerId, sessionId);
    let raw: string;
    let size: number;
    try {
      size = statSync(path).size;
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    if (size > this.maxFileBytes) {
      this.quarantine(customerId, sessionId, size);
      return null;
    }
    const rawLines = raw.split('\n');
    const lines: SessionLine[] = [];
    let torn = false;
    for (let index = 0; index < rawLines.length; index++) {
      const text = rawLines[index]!.trim();
      if (text.length === 0) {
        continue;
      }
      const parsed = parseSessionLine(text);
      if (parsed === null) {
        const isLastNonEmpty = rawLines.slice(index + 1).every((rest) => rest.trim().length === 0);
        if (isLastNonEmpty) {
          // Torn last line from a crash mid-append: drop it, keep the rest.
          torn = true;
          break;
        }
        this.quarantine(customerId, sessionId, size);
        return null;
      }
      lines.push(parsed);
    }
    if (torn) {
      const payload =
        lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : '');
      const tempPath = `${path}.tmp`;
      writeFileSync(tempPath, payload, { mode: FILE_MODE });
      renameSync(tempPath, path);
      this.globalBytes = Math.max(0, this.globalBytes - size + Buffer.byteLength(payload));
    }
    return lines;
  }

  private quarantine(customerId: string, sessionId: string, size: number): void {
    const path = this.sessionPath(customerId, sessionId);
    try {
      renameSync(path, `${path}.corrupt.${Date.now()}`);
      this.globalBytes = Math.max(0, this.globalBytes - size);
      this.compactionStrikes.delete(sessionKey(customerId, sessionId));
      this.log(`[sessions] ${sessionId.slice(0, 8)} corrupt; quarantined and reset`);
    } catch {
      /* best effort - a failed rename keeps the file; next open retries */
    }
  }

  /**
   * Kept-tail start index: the longest suffix of TURN lines whose combined
   * stored size stays within the keep budget, floored at the most recent turn.
   */
  private keptTailStart(lines: SessionLine[]): number {
    let budget = this.compactionKeepChars;
    let start = lines.length;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      if (line.type !== 'turn') {
        break;
      }
      const cost = line.content.length;
      if (cost > budget && start < lines.length) {
        break;
      }
      budget -= cost;
      start = index;
      if (budget <= 0) {
        break;
      }
    }
    if (start === lines.length && lines.length > 0) {
      // Even the most recent turn exceeds the budget - keep it anyway (floor).
      start = lines.length - 1;
    }
    return start;
  }

  private rewriteWithSummary(customerId: string, sessionId: string, summary: string): ChatTurn[] {
    validateKeys(customerId, sessionId);
    const lines = this.readSessionLines(customerId, sessionId) ?? [];
    const tailStart = this.keptTailStart(lines);
    const tail = lines.slice(tailStart).flatMap((line): TurnLine[] => {
      if (line.type !== 'turn') {
        return [];
      }
      // Floored single turn over half the trigger: truncate during the rewrite
      // so compaction cannot degenerate into re-summarizing its own summary.
      if (line.content.length > this.compactionKeepChars) {
        return [
          {
            ...line,
            content: line.content.slice(0, this.compactionKeepChars) + TRUNCATION_MARKER,
          },
        ];
      }
      return [line];
    });
    const summaryLine: SummaryLine = {
      type: 'summary',
      content: summary,
      ts: Math.floor(Date.now() / 1000),
    };
    const rewritten: SessionLine[] = [summaryLine, ...tail];
    const payload = rewritten.map((line) => JSON.stringify(line)).join('\n') + '\n';

    const path = this.sessionPath(customerId, sessionId);
    const oldSize = existsSync(path) ? statSync(path).size : 0;
    const tempPath = `${path}.tmp`;
    mkdirSync(join(this.root, customerId), { recursive: true, mode: DIR_MODE });
    writeFileSync(tempPath, payload, { mode: FILE_MODE });
    renameSync(tempPath, path);
    this.globalBytes = Math.max(0, this.globalBytes - oldSize + Buffer.byteLength(payload));

    return assembleReplay(rewritten, undefined);
  }

  /** New-session admission under the per-customer cap: LRU-evict an idle victim. */
  private ensureCustomerCapacity(customerId: string, sessionId: string): boolean {
    const dir = join(this.root, customerId);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return true; // no dir yet - first session for this customer
    }
    if (entries.length < this.maxPerCustomer) {
      return true;
    }
    const candidates = entries
      .map((name) => {
        const candidateSessionId = name.slice(0, -'.jsonl'.length);
        const path = join(dir, name);
        try {
          return { sessionId: candidateSessionId, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(
        (candidate): candidate is { sessionId: string; mtimeMs: number } => candidate !== null,
      )
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of candidates) {
      if (candidate.sessionId === sessionId) {
        continue;
      }
      if (this.deleteIfIdle(customerId, candidate.sessionId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Global LRU eviction down to the high-water mark. Excludes `selfKey` (the
   * arriving job's own session must not be its own victim).
   */
  private evictGlobal(selfKey: string): void {
    const files = this.listSessionFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (this.globalBytes <= this.globalEvictToBytes) {
        return;
      }
      if (sessionKey(file.customerId, file.sessionId) === selfKey) {
        continue;
      }
      this.deleteIfIdle(file.customerId, file.sessionId);
    }
  }

  /**
   * Delete a session iff idle: try-acquired mutex AND zero admitted count.
   * The mutex alone is not an in-flight guard - an admitted job spends its
   * whole payment phase before the mutex. Check and unlink are synchronous.
   */
  private deleteIfIdle(customerId: string, sessionId: string): boolean {
    const key = sessionKey(customerId, sessionId);
    const release = this.tryAcquireSync(key);
    if (release === null) {
      return false;
    }
    try {
      if (this.admittedCount(customerId, sessionId) > 0) {
        return false;
      }
      this.deleteSessionFile(customerId, sessionId);
      return true;
    } finally {
      release();
    }
  }

  private deleteSessionFile(customerId: string, sessionId: string): void {
    const path = this.sessionPath(customerId, sessionId);
    let size = 0;
    try {
      size = statSync(path).size;
      unlinkSync(path);
    } catch {
      return;
    }
    this.globalBytes = Math.max(0, this.globalBytes - size);
    this.compactionStrikes.delete(sessionKey(customerId, sessionId));
  }

  private listSessionFiles(): Array<{
    customerId: string;
    sessionId: string;
    size: number;
    mtimeMs: number;
  }> {
    const out: Array<{ customerId: string; sessionId: string; size: number; mtimeMs: number }> = [];
    let customers: string[];
    try {
      customers = readdirSync(this.root);
    } catch {
      return out;
    }
    for (const customerId of customers) {
      if (!CUSTOMER_PUBKEY_REGEX.test(customerId)) {
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(join(this.root, customerId));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID_REGEX.test(sessionId)) {
          continue;
        }
        try {
          const stat = statSync(join(this.root, customerId, name));
          out.push({ customerId, sessionId, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* raced deletion - skip */
        }
      }
    }
    return out;
  }

  private pruneSidecars(cutoffMs: number): void {
    let customers: string[];
    try {
      customers = readdirSync(this.root);
    } catch {
      return;
    }
    for (const customerId of customers) {
      const dir = join(this.root, customerId);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.includes('.corrupt.')) {
          continue;
        }
        const path = join(dir, name);
        try {
          if (statSync(path).mtimeMs < cutoffMs) {
            unlinkSync(path);
          }
        } catch {
          /* best effort */
        }
      }
    }
  }

  private pruneEmptyCustomerDirs(): void {
    let customers: string[];
    try {
      customers = readdirSync(this.root);
    } catch {
      return;
    }
    for (const customerId of customers) {
      const dir = join(this.root, customerId);
      try {
        if (readdirSync(dir).length === 0) {
          rmdirSync(dir);
        }
      } catch {
        /* raced with an append's mkdir - the append retries on ENOENT */
      }
    }
  }
}

function sessionKey(customerId: string, sessionId: string): string {
  return `${customerId}/${sessionId}`;
}

/**
 * Both components become filesystem path segments; anything off-shape must
 * never reach the fs layer. The transport (session ids) and signature
 * verification (pubkeys) already enforce these - this is defense in depth.
 */
function validateKeys(customerId: string, sessionId: string): void {
  if (!CUSTOMER_PUBKEY_REGEX.test(customerId)) {
    throw new Error('SessionStore: invalid customer pubkey');
  }
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error('SessionStore: invalid session id');
  }
}

function parseSessionLine(text: string): SessionLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'summary') {
    if (typeof record.content !== 'string' || typeof record.ts !== 'number') {
      return null;
    }
    return { type: 'summary', content: record.content, ts: record.ts };
  }
  if (record.type === 'turn') {
    if (
      (record.role !== 'user' && record.role !== 'assistant') ||
      typeof record.content !== 'string' ||
      typeof record.jobId !== 'string' ||
      typeof record.ts !== 'number'
    ) {
      return null;
    }
    return {
      type: 'turn',
      role: record.role,
      content: record.content,
      jobId: record.jobId,
      capability: typeof record.capability === 'string' ? record.capability : undefined,
      ts: record.ts,
    };
  }
  return null;
}

/**
 * Replay assembler (§2). Maps the transcript to provider-agnostic messages:
 * summary first as a marked user-role message, then turns in order. Over the
 * fully assembled list (summary included): skip empty content, drop leading
 * assistant messages, drop trailing user messages (a torn assistant line or a
 * skipped-empty output would otherwise create a user-user seam with the
 * current job's message), then merge consecutive same-role neighbors - some
 * providers (deepseek-reasoner) reject successive same-role messages with a
 * 400 rather than merging them like Anthropic does. Result: empty, or starts
 * with user, ends with assistant, no empties, no same-role neighbors.
 */
function assembleReplay(lines: SessionLine[], excludeJobId: string | undefined): ChatTurn[] {
  const raw: ChatTurn[] = [];
  for (const line of lines) {
    if (line.type === 'summary') {
      raw.push({ role: 'user', content: `${SESSION_SUMMARY_PREFIX}\n${line.content}` });
    } else if (line.jobId !== excludeJobId) {
      raw.push({ role: line.role, content: line.content });
    }
  }

  const nonEmpty = raw.filter((message) => message.content.trim().length > 0);

  let start = 0;
  while (start < nonEmpty.length && nonEmpty[start]!.role === 'assistant') {
    start++;
  }
  let end = nonEmpty.length;
  while (end > start && nonEmpty[end - 1]!.role === 'user') {
    end--;
  }
  const bounded = nonEmpty.slice(start, end);

  const merged: ChatTurn[] = [];
  for (const message of bounded) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
}

/** Flatten the to-be-summarized prefix (everything before the kept tail). */
function buildSummarizeText(lines: SessionLine[], tailStart: number): string {
  const parts: string[] = [];
  for (const line of lines.slice(0, tailStart)) {
    if (line.type === 'summary') {
      parts.push(`Summary of earlier conversation:\n${line.content}`);
    } else {
      parts.push(`${line.role === 'user' ? 'User' : 'Assistant'}: ${line.content}`);
    }
  }
  return parts.join('\n\n');
}

function truncateTurn(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content) <= maxBytes) {
    return content;
  }
  // Slice by chars (safe upper bound: chars <= bytes) then re-check.
  let sliced = content.slice(0, maxBytes - TRUNCATION_MARKER.length);
  while (Buffer.byteLength(sliced) > maxBytes - TRUNCATION_MARKER.length) {
    sliced = sliced.slice(0, Math.floor(sliced.length * 0.9));
  }
  return sliced + TRUNCATION_MARKER;
}
