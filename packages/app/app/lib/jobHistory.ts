/**
 * Identity-keyed job history (`elisym:job-history:<nostr pubkey>`) as a shared
 * module store behind the readCursors listener/version idiom, so BuyContext's
 * writes reach every subscriber (nav badge, /jobs page, Chat tab) reactively.
 *
 * Keyed by the NOSTR key, not the Solana wallet it used to be: what binds a job
 * to a person is the key that signed the request - the relay knows nothing
 * about the payer's wallet, and the relay half of /jobs already queries by it.
 * A customer paying from an EVM wallet has no Solana address at all, and one
 * paying from two wallets is one customer with one history. A legacy per-wallet
 * store migrates once, to the identity active at the time (see
 * `migrateLegacyJobHistory`).
 *
 * Writes are read-modify-write PATCHES against localStorage keyed by
 * `jobEventId`, never a persist of a caller's whole in-memory array: under two
 * tabs a full-snapshot write lets a stale tab clobber the other's flips
 * (revert a `completed` row to `pending`, re-stamp `unseen` after a clear).
 * A patch spread keeps explicitly-`undefined` keys, and JSON serialization
 * drops them, so `{ txHash: undefined }` clears the field on persist (the
 * PaymentRevertedError branch relies on exactly that).
 *
 * Accepted residual: two tabs' concurrent read-modify-write can lose an
 * `unseen` stamp - and, in the same millisecond window, a just-stamped
 * delegated settlement txHash under a concurrent flip from another tab.
 * Statuses self-heal on the next poll tick, a missed badge is cosmetic, and
 * for the txHash the on-chain delegation record remains the truth (the
 * thread entry keeps its own copy) - so this store stays synchronous
 * instead of adopting the async `navigator.locks` path chatSession needs.
 */

import type { SolanaCluster } from './cluster';

export const JOB_HISTORY_KEY_PREFIX = 'elisym:job-history:';
/** One marker per identity, so a deleted history is not restored on the next load. */
export const JOB_HISTORY_MIGRATED_PREFIX = 'elisym:job-history-migrated:';

/** A Nostr public key as this app stores it: 32 bytes of lowercase hex. */
const IDENTITY_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The instant the elisym mainnet config PDA was initialized:
 * 2026-08-21T12:58:48Z, transaction `iSP4xNfw1b78...`.
 *
 * Relay-side job events carry no network field, so the /jobs merge classifies
 * them by this cutoff: created before it = devnet. A matching local entry for
 * the same job event overrides the cutoff (see routes/Jobs/lib/rows.ts) - a
 * stale pre-flip tab can submit devnet jobs after the epoch, and its local
 * stamp (or the absence of one) is the better witness.
 *
 * This is the config's own creation time, not the day the web app went
 * mainnet, and the difference matters in both directions. Nothing on mainnet
 * can predate it: `getProtocolConfig` reads fee and treasury from that PDA, so
 * no payment could be built before it existed. Dating the epoch later instead
 * - to the app deploy - would file every job from the pre-launch mainnet
 * testing as devnet and hide it from /jobs. Rounding it down to the hour would
 * fail the other way, pulling that hour's devnet jobs into the mainnet list.
 */
export const MAINNET_EPOCH_SECS = 1_787_317_128;

const TERMINAL_STATUSES = new Set(['completed', 'error']);

export interface StoredJob {
  jobEventId: string;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  capability: string;
  status: string;
  /** Raw subunits of `assetKey`'s asset - stamped together at tx broadcast. */
  paymentAmount?: number;
  /** SDK assetKey of the charged asset; absent on legacy and unpaid rows. */
  assetKey?: string;
  txHash?: string;
  result?: string;
  createdAt: number;
  /** Epoch ms of the terminal flip. */
  completedAt?: number;
  /** Result landed while the user was not looking; cleared by /jobs and the Chat tab. */
  unseen?: boolean;
  /**
   * Cluster the job was submitted on. Absent = a legacy pre-mainnet entry,
   * which is devnet by definition (D13) - hidden on the mainnet domain.
   */
  network?: SolanaCluster;
}

export interface JobHistoryStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Every key present, for the one-time migration off the wallet-keyed store. */
  keys(): string[];
  removeItem(key: string): void;
}

export interface JobHistoryStore {
  readJobs(owner: string): StoredJob[];
  migrateLegacyJobHistory(owner: string): void;
  purgeJobHistory(owner: string): void;
  saveJob(owner: string, job: StoredJob): void;
  updateJob(owner: string, jobEventId: string, patch: Partial<StoredJob>): void;
  flipTerminal(
    owner: string,
    jobEventId: string,
    patch: Partial<StoredJob>,
    opts: { stampUnseen: boolean },
  ): void;
  clearUnseen(owner: string, agentPubkey?: string): void;
  unseenCount(owner: string, network: SolanaCluster): number;
  handleExternalChange(key: string): void;
  subscribe(listener: () => void): () => void;
  version(): number;
}

const browserStorage: JobHistoryStorageAdapter = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota/private-mode failures degrade to per-tab state - harmless.
    }
  },
  keys: () => {
    try {
      return Object.keys(localStorage);
    } catch {
      return [];
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Same degradation as setItem: a purge that cannot write is a no-op.
    }
  },
};

const EMPTY_JOBS: StoredJob[] = [];

function storageKey(owner: string): string {
  return `${JOB_HISTORY_KEY_PREFIX}${owner}`;
}

/** Tolerant parse (the readCursors idiom): a corrupt value reads as empty. */
function parseJobs(raw: string | null): StoredJob[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (entry): entry is StoredJob =>
      typeof entry === 'object' &&
      entry !== null &&
      'jobEventId' in entry &&
      typeof (entry as { jobEventId: unknown }).jobEventId === 'string',
  );
}

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Unstamped local entries predate the mainnet flip and are devnet (D13). */
export function localJobNetwork(job: StoredJob): SolanaCluster {
  return job.network ?? 'devnet';
}

export function createJobHistoryStore(
  storage: JobHistoryStorageAdapter = browserStorage,
): JobHistoryStore {
  const listeners = new Set<() => void>();
  let storeVersion = 0;
  /** getSnapshot stability: one cached array per identity, invalidated by version. */
  const snapshots = new Map<string, { version: number; jobs: StoredJob[] }>();

  function notify(): void {
    storeVersion += 1;
    for (const listener of listeners) {
      listener();
    }
  }

  function readRaw(owner: string): StoredJob[] {
    return parseJobs(storage.getItem(storageKey(owner)));
  }

  function persist(owner: string, jobs: StoredJob[]): void {
    storage.setItem(storageKey(owner), JSON.stringify(jobs));
    notify();
  }

  function readJobs(owner: string): StoredJob[] {
    if (!owner) {
      return EMPTY_JOBS;
    }
    const cached = snapshots.get(owner);
    if (cached && cached.version === storeVersion) {
      return cached.jobs;
    }
    const jobs = readRaw(owner);
    snapshots.set(owner, { version: storeVersion, jobs });
    return jobs;
  }

  function saveJob(owner: string, job: StoredJob): void {
    if (!owner) {
      return;
    }
    const current = readRaw(owner);
    persist(owner, [job, ...current.filter((existing) => existing.jobEventId !== job.jobEventId)]);
  }

  function updateJob(owner: string, jobEventId: string, patch: Partial<StoredJob>): void {
    if (!owner) {
      return;
    }
    const current = readRaw(owner);
    const row = current.find((existing) => existing.jobEventId === jobEventId);
    if (!row) {
      // Never create an absent row, and a no-op must not bump the version.
      return;
    }
    // Terminal status is sticky: a late non-terminal writer (an onTimeout or
    // resumable-payment `pending` racing the poller or another tab's flip)
    // must not revert a `completed`/`error` row - the poller skips rows with
    // results, so the row would show "In progress" forever. Non-status keys
    // still apply: the revert cleanup and txHash stamps rely on that.
    const { status: patchStatus, ...restPatch } = patch;
    const demotesTerminal =
      patchStatus !== undefined &&
      isTerminalJobStatus(row.status) &&
      !isTerminalJobStatus(patchStatus);
    const effectivePatch = demotesTerminal ? restPatch : patch;
    if (Object.keys(effectivePatch).length === 0) {
      return;
    }
    persist(
      owner,
      current.map((existing) =>
        existing.jobEventId === jobEventId ? { ...existing, ...effectivePatch } : existing,
      ),
    );
  }

  function flipTerminal(
    owner: string,
    jobEventId: string,
    patch: Partial<StoredJob>,
    opts: { stampUnseen: boolean },
  ): void {
    if (!owner) {
      return;
    }
    const current = readRaw(owner);
    const row = current.find((existing) => existing.jobEventId === jobEventId);
    // Decided against the freshly-read row: if another tab (or an earlier
    // path) already flipped this job, re-applying the flip would resurrect
    // an `unseen` flag the /jobs page may have cleared since.
    if (!row || isTerminalJobStatus(row.status)) {
      return;
    }
    persist(
      owner,
      current.map((existing) =>
        existing.jobEventId === jobEventId
          ? {
              ...existing,
              ...patch,
              completedAt: Date.now(),
              ...(opts.stampUnseen ? { unseen: true } : {}),
            }
          : existing,
      ),
    );
  }

  function clearUnseen(owner: string, agentPubkey?: string): void {
    if (!owner) {
      return;
    }
    const current = readRaw(owner);
    const matches = (job: StoredJob): boolean =>
      job.unseen === true && (agentPubkey === undefined || job.agentPubkey === agentPubkey);
    if (!current.some(matches)) {
      // No-op clears must not write: the clear-while-mounted effects key on
      // the version this write would bump - writing anyway would loop.
      return;
    }
    persist(
      owner,
      current.map((job) => (matches(job) ? { ...job, unseen: undefined } : job)),
    );
  }

  // The badge counts only entries visible on the current network (D13): a
  // legacy devnet flip must not light the badge on the mainnet domain for a
  // row the /jobs page will never show.
  function unseenCount(owner: string, network: SolanaCluster): number {
    let count = 0;
    for (const job of readJobs(owner)) {
      if (job.unseen === true && localJobNetwork(job) === network) {
        count += 1;
      }
    }
    return count;
  }

  function handleExternalChange(key: string): void {
    if (key.startsWith(JOB_HISTORY_KEY_PREFIX)) {
      notify();
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Copy a legacy wallet-keyed history onto `owner`, ONCE.
   *
   * Runs only when the identity has no history of its own and has not been
   * migrated before - so a user who cleared their jobs does not get them back
   * on the next load. The legacy key is left in place: it is a few kilobytes,
   * and an older tab or a rolled-back deploy keeps working.
   *
   * With several legacy stores there is no honest way to attribute the others,
   * and merging strangers' rows into one list would be worse than leaving them,
   * so the most recently USED one wins - the same "the identity active at first
   * load" rule, applied to the other side.
   */
  function migrateLegacyJobHistory(owner: string): void {
    if (!owner || storage.getItem(`${JOB_HISTORY_MIGRATED_PREFIX}${owner}`) !== null) {
      return;
    }
    storage.setItem(`${JOB_HISTORY_MIGRATED_PREFIX}${owner}`, String(Date.now()));
    if (storage.getItem(storageKey(owner)) !== null) {
      return;
    }
    let best: { jobs: StoredJob[]; newest: number } | null = null;
    for (const key of storage.keys()) {
      if (!key.startsWith(JOB_HISTORY_KEY_PREFIX)) {
        continue;
      }
      const suffix = key.slice(JOB_HISTORY_KEY_PREFIX.length);
      // Both shapes are written by us, so this tells them apart exactly: a
      // Solana address is base58 and never 64 lowercase hex characters.
      if (suffix === '' || IDENTITY_KEY_RE.test(suffix)) {
        continue;
      }
      const jobs = parseJobs(storage.getItem(key));
      if (jobs.length === 0) {
        continue;
      }
      const newest = Math.max(...jobs.map((job) => job.createdAt));
      if (best === null || newest > best.newest) {
        best = { jobs, newest };
      }
    }
    if (best !== null) {
      persist(owner, best.jobs);
    }
  }

  /**
   * Delete one identity's history, for logout.
   *
   * The MIGRATION MARKER deliberately stays: without it, logging the same key
   * back in would copy the legacy wallet-keyed store over again and resurrect
   * exactly what this just deleted.
   */
  function purgeJobHistory(owner: string): void {
    if (!owner || storage.getItem(storageKey(owner)) === null) {
      return;
    }
    storage.removeItem(storageKey(owner));
    snapshots.delete(owner);
    notify();
  }

  function version(): number {
    return storeVersion;
  }

  return {
    readJobs,
    migrateLegacyJobHistory,
    purgeJobHistory,
    saveJob,
    updateJob,
    flipTerminal,
    clearUnseen,
    unseenCount,
    handleExternalChange,
    subscribe,
    version,
  };
}

const defaultStore = createJobHistoryStore();

if (typeof window !== 'undefined') {
  // Cross-tab reactivity: another tab's write arrives as a `storage` event;
  // bumping the version re-derives every subscriber's snapshot.
  window.addEventListener('storage', (event) => {
    if (event.key !== null) {
      defaultStore.handleExternalChange(event.key);
    }
  });
}

export const readJobs = defaultStore.readJobs;
export const migrateLegacyJobHistory = defaultStore.migrateLegacyJobHistory;
export const purgeJobHistory = defaultStore.purgeJobHistory;
export const saveJob = defaultStore.saveJob;
export const updateJob = defaultStore.updateJob;
export const flipTerminal = defaultStore.flipTerminal;
export const clearUnseen = defaultStore.clearUnseen;
export const unseenJobsCount = defaultStore.unseenCount;
/** Subscription surface for useSyncExternalStore. */
export const subscribeJobHistory = defaultStore.subscribe;
export const jobHistoryVersion = defaultStore.version;
