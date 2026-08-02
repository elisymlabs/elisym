/**
 * Wallet-keyed job history (`elisym:job-history:<wallet>`) as a shared module
 * store behind the readCursors listener/version idiom, so BuyContext's writes
 * reach every subscriber (nav badge, /jobs page, Chat tab) reactively.
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

/**
 * TODO(mainnet launch): PLACEHOLDER - this MUST be set to the real
 * production-deploy unix timestamp at the Phase 5 launch moment
 * (docs/plans/solana-mainnet.md, D13 + "Remaining open items"). Until then it
 * sits at 2100-01-01 so every relay-side job classifies as devnet.
 *
 * Relay-side job events carry no network field, so the /jobs merge classifies
 * them by this cutoff: created before the mainnet launch = devnet. A matching
 * local entry for the same job event overrides the cutoff (see
 * routes/Jobs/lib/rows.ts) - a stale pre-flip tab can submit devnet jobs
 * after the epoch, and its local stamp (or the absence of one) is the better
 * witness.
 */
export const MAINNET_EPOCH_SECS = 4_102_444_800;

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
}

export interface JobHistoryStore {
  readJobs(wallet: string): StoredJob[];
  saveJob(wallet: string, job: StoredJob): void;
  updateJob(wallet: string, jobEventId: string, patch: Partial<StoredJob>): void;
  flipTerminal(
    wallet: string,
    jobEventId: string,
    patch: Partial<StoredJob>,
    opts: { stampUnseen: boolean },
  ): void;
  clearUnseen(wallet: string, agentPubkey?: string): void;
  unseenCount(wallet: string, network: SolanaCluster): number;
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
};

const EMPTY_JOBS: StoredJob[] = [];

function storageKey(wallet: string): string {
  return `${JOB_HISTORY_KEY_PREFIX}${wallet}`;
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
  /** getSnapshot stability: one cached array per wallet, invalidated by version. */
  const snapshots = new Map<string, { version: number; jobs: StoredJob[] }>();

  function notify(): void {
    storeVersion += 1;
    for (const listener of listeners) {
      listener();
    }
  }

  function readRaw(wallet: string): StoredJob[] {
    return parseJobs(storage.getItem(storageKey(wallet)));
  }

  function persist(wallet: string, jobs: StoredJob[]): void {
    storage.setItem(storageKey(wallet), JSON.stringify(jobs));
    notify();
  }

  function readJobs(wallet: string): StoredJob[] {
    if (!wallet) {
      return EMPTY_JOBS;
    }
    const cached = snapshots.get(wallet);
    if (cached && cached.version === storeVersion) {
      return cached.jobs;
    }
    const jobs = readRaw(wallet);
    snapshots.set(wallet, { version: storeVersion, jobs });
    return jobs;
  }

  function saveJob(wallet: string, job: StoredJob): void {
    if (!wallet) {
      return;
    }
    const current = readRaw(wallet);
    persist(wallet, [job, ...current.filter((existing) => existing.jobEventId !== job.jobEventId)]);
  }

  function updateJob(wallet: string, jobEventId: string, patch: Partial<StoredJob>): void {
    if (!wallet) {
      return;
    }
    const current = readRaw(wallet);
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
      wallet,
      current.map((existing) =>
        existing.jobEventId === jobEventId ? { ...existing, ...effectivePatch } : existing,
      ),
    );
  }

  function flipTerminal(
    wallet: string,
    jobEventId: string,
    patch: Partial<StoredJob>,
    opts: { stampUnseen: boolean },
  ): void {
    if (!wallet) {
      return;
    }
    const current = readRaw(wallet);
    const row = current.find((existing) => existing.jobEventId === jobEventId);
    // Decided against the freshly-read row: if another tab (or an earlier
    // path) already flipped this job, re-applying the flip would resurrect
    // an `unseen` flag the /jobs page may have cleared since.
    if (!row || isTerminalJobStatus(row.status)) {
      return;
    }
    persist(
      wallet,
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

  function clearUnseen(wallet: string, agentPubkey?: string): void {
    if (!wallet) {
      return;
    }
    const current = readRaw(wallet);
    const matches = (job: StoredJob): boolean =>
      job.unseen === true && (agentPubkey === undefined || job.agentPubkey === agentPubkey);
    if (!current.some(matches)) {
      // No-op clears must not write: the clear-while-mounted effects key on
      // the version this write would bump - writing anyway would loop.
      return;
    }
    persist(
      wallet,
      current.map((job) => (matches(job) ? { ...job, unseen: undefined } : job)),
    );
  }

  // The badge counts only entries visible on the current network (D13): a
  // legacy devnet flip must not light the badge on the mainnet domain for a
  // row the /jobs page will never show.
  function unseenCount(wallet: string, network: SolanaCluster): number {
    let count = 0;
    for (const job of readJobs(wallet)) {
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

  function version(): number {
    return storeVersion;
  }

  return {
    readJobs,
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
export const saveJob = defaultStore.saveJob;
export const updateJob = defaultStore.updateJob;
export const flipTerminal = defaultStore.flipTerminal;
export const clearUnseen = defaultStore.clearUnseen;
export const unseenJobsCount = defaultStore.unseenCount;
/** Subscription surface for useSyncExternalStore. */
export const subscribeJobHistory = defaultStore.subscribe;
export const jobHistoryVersion = defaultStore.version;
