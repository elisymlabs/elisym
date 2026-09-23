/**
 * Shared job-history store tests (`lib/jobHistory.ts`): patch-write semantics
 * (read-modify-write by jobEventId, explicit-undefined clears on persist),
 * the terminal-flip freshly-read-row guard, unseen stamping/clearing with the
 * no-op-write loop guard, legacy-entry compat, storage-event version bumps,
 * and getSnapshot stability.
 */
import { describe, expect, it } from 'vitest';
import {
  createJobHistoryStore,
  isTerminalJobStatus,
  JOB_HISTORY_KEY_PREFIX,
  JOB_HISTORY_MIGRATED_KEY,
  localJobNetwork,
  type JobHistoryStorageAdapter,
  type StoredJob,
} from '~/lib/jobHistory';

const WALLET = 'wallet-a';

function memoryStorage(seed: Record<string, string> = {}): JobHistoryStorageAdapter & {
  raw(key: string): string | null;
} {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    keys: () => [...data.keys()],
    removeItem: (key) => {
      data.delete(key);
    },
    raw: (key) => data.get(key) ?? null,
  };
}

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    jobEventId: 'job-1',
    agentPubkey: 'agent-1',
    agentName: 'Agent One',
    capability: 'summarize',
    status: 'submitted',
    createdAt: 1000,
    ...overrides,
  };
}

describe('jobHistory store', () => {
  it('saveJob prepends and dedups by jobEventId', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ jobEventId: 'a' }));
    store.saveJob(WALLET, job({ jobEventId: 'b' }));
    store.saveJob(WALLET, job({ jobEventId: 'a', capability: 'translate' }));

    const jobs = store.readJobs(WALLET);
    expect(jobs.map((entry) => entry.jobEventId)).toEqual(['a', 'b']);
    expect(jobs[0]?.capability).toBe('translate');
  });

  it('updateJob patches only the target row and never creates absent rows', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ jobEventId: 'a' }));
    store.saveJob(WALLET, job({ jobEventId: 'b' }));
    const versionBefore = store.version();

    store.updateJob(WALLET, 'a', { status: 'pending' });
    expect(store.readJobs(WALLET).find((entry) => entry.jobEventId === 'a')?.status).toBe(
      'pending',
    );
    expect(store.readJobs(WALLET).find((entry) => entry.jobEventId === 'b')?.status).toBe(
      'submitted',
    );

    const versionAfterPatch = store.version();
    expect(versionAfterPatch).toBe(versionBefore + 1);

    // Absent row: no write, no version bump (no-create + no-op-write rules).
    store.updateJob(WALLET, 'missing', { status: 'completed' });
    expect(store.version()).toBe(versionAfterPatch);
    expect(store.readJobs(WALLET)).toHaveLength(2);
  });

  it('updateJob never demotes a terminal status (late pending writer)', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ status: 'pending' }));
    store.flipTerminal(
      WALLET,
      'job-1',
      { status: 'completed', result: 'ok' },
      {
        stampUnseen: false,
      },
    );

    // A status-only demote (the onTimeout/resumable `pending` writers racing
    // the poller) is a full no-op: no revert, no version bump.
    const versionBefore = store.version();
    store.updateJob(WALLET, 'job-1', { status: 'pending' });
    expect(store.readJobs(WALLET)[0]?.status).toBe('completed');
    expect(store.version()).toBe(versionBefore);

    // Non-status keys in the same patch still apply (revert cleanup and
    // txHash stamps rely on that).
    store.updateJob(WALLET, 'job-1', { status: 'pending', txHash: 'late-sig' });
    const row = store.readJobs(WALLET)[0];
    expect(row?.status).toBe('completed');
    expect(row?.txHash).toBe('late-sig');
  });

  it('updateJob explicit-undefined clears reach a terminal row (revert after error flip)', () => {
    const storage = memoryStorage();
    const store = createJobHistoryStore(storage);
    store.saveJob(
      WALLET,
      job({ status: 'pending', txHash: 'sig', paymentAmount: 5_000_000, assetKey: 'solana:sol' }),
    );
    // A provider error feedback flips the row terminal while the payment is
    // still confirming...
    store.flipTerminal(WALLET, 'job-1', { status: 'error' }, { stampUnseen: true });
    // ...then the on-chain revert cleanup must still clear the charge fields
    // (flipTerminal would drop the patch - the revert path uses updateJob).
    store.updateJob(WALLET, 'job-1', {
      txHash: undefined,
      paymentAmount: undefined,
      assetKey: undefined,
    });

    const raw = storage.raw(`${JOB_HISTORY_KEY_PREFIX}${WALLET}`) ?? '';
    expect(raw).not.toContain('txHash');
    expect(raw).not.toContain('paymentAmount');
    expect(raw).not.toContain('assetKey');
    expect(store.readJobs(WALLET)[0]?.status).toBe('error');
  });

  it('explicitly-undefined patch keys clear fields on persist (revert path)', () => {
    const storage = memoryStorage();
    const store = createJobHistoryStore(storage);
    store.saveJob(
      WALLET,
      job({ txHash: 'sig', paymentAmount: 5_000_000, assetKey: 'solana:usdc:mint' }),
    );

    store.flipTerminal(
      WALLET,
      'job-1',
      { status: 'error', txHash: undefined, paymentAmount: undefined, assetKey: undefined },
      { stampUnseen: false },
    );

    const raw = storage.raw(`${JOB_HISTORY_KEY_PREFIX}${WALLET}`) ?? '';
    expect(raw).not.toContain('txHash');
    expect(raw).not.toContain('paymentAmount');
    expect(raw).not.toContain('assetKey');
    const row = store.readJobs(WALLET)[0];
    expect(row?.status).toBe('error');
    expect(row?.txHash).toBeUndefined();
  });

  it('flipTerminal stamps completedAt and unseen, and no-ops on terminal rows', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ status: 'pending' }));

    store.flipTerminal(
      WALLET,
      'job-1',
      { status: 'completed', result: 'ok' },
      {
        stampUnseen: true,
      },
    );
    const flipped = store.readJobs(WALLET)[0];
    expect(flipped?.status).toBe('completed');
    expect(flipped?.unseen).toBe(true);
    expect(typeof flipped?.completedAt).toBe('number');

    // The freshly-read-row guard: a second (stale-tab) flip must not
    // resurrect the flag after a clear.
    store.clearUnseen(WALLET);
    expect(store.readJobs(WALLET)[0]?.unseen).toBeUndefined();
    store.flipTerminal(
      WALLET,
      'job-1',
      { status: 'completed', result: 'ok' },
      {
        stampUnseen: true,
      },
    );
    expect(store.readJobs(WALLET)[0]?.unseen).toBeUndefined();
  });

  it('flipTerminal without stampUnseen leaves the flag off', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ status: 'pending' }));
    store.flipTerminal(WALLET, 'job-1', { status: 'completed' }, { stampUnseen: false });
    expect(store.readJobs(WALLET)[0]?.unseen).toBeUndefined();
    expect(store.unseenCount(WALLET, 'devnet')).toBe(0);
  });

  it('clearUnseen scopes to an agent and skips the write when nothing is set', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ jobEventId: 'a', agentPubkey: 'agent-1', status: 'pending' }));
    store.saveJob(WALLET, job({ jobEventId: 'b', agentPubkey: 'agent-2', status: 'pending' }));
    store.flipTerminal(WALLET, 'a', { status: 'completed' }, { stampUnseen: true });
    store.flipTerminal(WALLET, 'b', { status: 'completed' }, { stampUnseen: true });
    expect(store.unseenCount(WALLET, 'devnet')).toBe(2);

    store.clearUnseen(WALLET, 'agent-1');
    expect(store.unseenCount(WALLET, 'devnet')).toBe(1);
    expect(store.readJobs(WALLET).find((entry) => entry.jobEventId === 'b')?.unseen).toBe(true);

    store.clearUnseen(WALLET);
    expect(store.unseenCount(WALLET, 'devnet')).toBe(0);

    // Loop guard: a clear with nothing to clear must not bump the version -
    // the clear-while-mounted effects key on it.
    const versionAfter = store.version();
    store.clearUnseen(WALLET);
    store.clearUnseen(WALLET, 'agent-1');
    expect(store.version()).toBe(versionAfter);
  });

  it('keeps legacy entries without the new fields valid', () => {
    const legacy = JSON.stringify([
      {
        jobEventId: 'old-1',
        agentPubkey: 'agent-1',
        agentName: 'Agent One',
        capability: 'summarize',
        status: 'completed',
        paymentAmount: 123,
        createdAt: 500,
      },
    ]);
    const store = createJobHistoryStore(
      memoryStorage({ [`${JOB_HISTORY_KEY_PREFIX}${WALLET}`]: legacy }),
    );
    const jobs = store.readJobs(WALLET);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.assetKey).toBeUndefined();
    expect(jobs[0]?.completedAt).toBeUndefined();

    store.updateJob(WALLET, 'old-1', { result: 'late result' });
    expect(store.readJobs(WALLET)[0]?.result).toBe('late result');
  });

  it('reads corrupt or non-array payloads as empty', () => {
    const key = `${JOB_HISTORY_KEY_PREFIX}${WALLET}`;
    expect(createJobHistoryStore(memoryStorage({ [key]: 'not json' })).readJobs(WALLET)).toEqual(
      [],
    );
    expect(createJobHistoryStore(memoryStorage({ [key]: '{"jobs":[]}' })).readJobs(WALLET)).toEqual(
      [],
    );
  });

  it('bumps the version on matching external storage events only', () => {
    const store = createJobHistoryStore(memoryStorage());
    const versionBefore = store.version();
    store.handleExternalChange('elisym:dm-read:someone');
    expect(store.version()).toBe(versionBefore);
    store.handleExternalChange(`${JOB_HISTORY_KEY_PREFIX}other-wallet`);
    expect(store.version()).toBe(versionBefore + 1);
  });

  it('returns stable snapshots per (wallet, version)', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job());

    const first = store.readJobs(WALLET);
    expect(store.readJobs(WALLET)).toBe(first);

    store.updateJob(WALLET, 'job-1', { status: 'pending' });
    const second = store.readJobs(WALLET);
    expect(second).not.toBe(first);
    expect(store.readJobs(WALLET)).toBe(second);

    // The empty-wallet snapshot is a stable constant.
    expect(store.readJobs('')).toBe(store.readJobs(''));
  });

  it('notifies subscribers on writes', () => {
    const store = createJobHistoryStore(memoryStorage());
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.saveJob(WALLET, job());
    store.updateJob(WALLET, 'job-1', { status: 'pending' });
    unsubscribe();
    store.updateJob(WALLET, 'job-1', { status: 'completed' });
    expect(notified).toBe(2);
  });

  it('classifies terminal statuses', () => {
    expect(isTerminalJobStatus('completed')).toBe(true);
    expect(isTerminalJobStatus('error')).toBe(true);
    expect(isTerminalJobStatus('pending')).toBe(false);
    expect(isTerminalJobStatus('payment-completed')).toBe(false);
    expect(isTerminalJobStatus('submitted')).toBe(false);
  });

  it('unseenCount scopes to the network - unstamped entries count as devnet (D13)', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ jobEventId: 'legacy', unseen: true }));
    store.saveJob(WALLET, job({ jobEventId: 'dev', unseen: true, network: 'devnet' }));
    store.saveJob(WALLET, job({ jobEventId: 'main', unseen: true, network: 'mainnet' }));

    expect(store.unseenCount(WALLET, 'devnet')).toBe(2);
    expect(store.unseenCount(WALLET, 'mainnet')).toBe(1);
  });

  it('localJobNetwork reads unstamped entries as devnet', () => {
    expect(localJobNetwork(job())).toBe('devnet');
    expect(localJobNetwork(job({ network: 'devnet' }))).toBe('devnet');
    expect(localJobNetwork(job({ network: 'mainnet' }))).toBe('mainnet');
  });
});

describe('the one-time move off the wallet-keyed store', () => {
  const IDENTITY = 'a'.repeat(64);
  const OTHER_IDENTITY = 'b'.repeat(64);
  const LEGACY = `${JOB_HISTORY_KEY_PREFIX}SoLanaWa11etAddress`;

  function legacySeed(jobs: StoredJob[], key = LEGACY): Record<string, string> {
    return { [key]: JSON.stringify(jobs) };
  }

  it('copies a legacy wallet store onto the identity, and leaves the original alone', () => {
    // Left in place on purpose: it is a few kilobytes, it holds the only local
    // record of what was paid, and an older tab or a rolled-back deploy keeps
    // reading it.
    const storage = memoryStorage(legacySeed([job({ jobEventId: 'old-1' })]));
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY).map((entry) => entry.jobEventId)).toEqual(['old-1']);
    expect(storage.raw(LEGACY)).not.toBeNull();
  });

  it('does not copy again after the history has been cleared', () => {
    const storage = memoryStorage(legacySeed([job({ jobEventId: 'old-1' })]));
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    store.purgeJobHistory(IDENTITY);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY)).toEqual([]);
  });

  it('copies to the FIRST identity only - never to a second one', () => {
    // The legacy store is left on disk, so a per-identity marker would let
    // every key that ever became active here inherit a stranger's purchases,
    // with their amounts, agents and payment hashes. A provider key pasted on
    // a shared machine is exactly that case.
    const storage = memoryStorage(legacySeed([job({ jobEventId: 'alice-1' })]));
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    store.migrateLegacyJobHistory(OTHER_IDENTITY);
    expect(store.readJobs(OTHER_IDENTITY)).toEqual([]);
  });

  it('retries the copy when the write did not land', () => {
    // `setItem` swallows a quota failure by design. A marker written first
    // would record as done a copy that never happened, and the ledger - the
    // only local record of what was paid - would be gone with no retry.
    const storage = memoryStorage(legacySeed([job({ jobEventId: 'old-1' })]));
    const full = { ...storage, setItem: () => undefined };
    createJobHistoryStore(full).migrateLegacyJobHistory(IDENTITY);
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY).map((entry) => entry.jobEventId)).toEqual(['old-1']);
  });

  it('does not let a row with no timestamp beat one that has them', () => {
    // `Math.max` over a missing `createdAt` is NaN, which loses to nothing and
    // therefore wins for ever - and the wrong wallet's history is copied.
    const storage = memoryStorage({
      [`${JOB_HISTORY_KEY_PREFIX}WalletOne`]: JSON.stringify([
        { jobEventId: 'undated', agentPubkey: 'a', agentName: 'A', capability: 'c', status: 's' },
      ]),
      [`${JOB_HISTORY_KEY_PREFIX}WalletTwo`]: JSON.stringify([
        job({ jobEventId: 'dated', createdAt: 9000 }),
      ]),
    });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY).map((entry) => entry.jobEventId)).toEqual(['dated']);
  });

  it('never overwrites a history the identity already has', () => {
    const storage = memoryStorage({
      ...legacySeed([job({ jobEventId: 'old-1' })]),
      [`${JOB_HISTORY_KEY_PREFIX}${IDENTITY}`]: JSON.stringify([job({ jobEventId: 'mine' })]),
    });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY).map((entry) => entry.jobEventId)).toEqual(['mine']);
  });

  it('takes the most recently used store when several wallets left one', () => {
    // There is no honest way to attribute the others, and merging strangers'
    // rows into one list would be worse than leaving them where they are.
    const storage = memoryStorage({
      [`${JOB_HISTORY_KEY_PREFIX}WalletOne`]: JSON.stringify([
        job({ jobEventId: 'older', createdAt: 1000 }),
      ]),
      [`${JOB_HISTORY_KEY_PREFIX}WalletTwo`]: JSON.stringify([
        job({ jobEventId: 'newer', createdAt: 9000 }),
      ]),
    });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY).map((entry) => entry.jobEventId)).toEqual(['newer']);
  });

  it('never copies ANOTHER identity’s history', () => {
    // The two shapes are both written by us, so this rule is total: a Solana
    // address is base58 and never 64 lowercase hex characters.
    const storage = memoryStorage({
      [`${JOB_HISTORY_KEY_PREFIX}${OTHER_IDENTITY}`]: JSON.stringify([
        job({ jobEventId: 'someone-else' }),
      ]),
    });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY)).toEqual([]);
  });

  it('marks the browser even when there was nothing to copy', () => {
    const storage = memoryStorage();
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(storage.raw(JOB_HISTORY_MIGRATED_KEY)).not.toBeNull();
  });

  it('ignores an empty legacy store', () => {
    const storage = memoryStorage({ [LEGACY]: JSON.stringify([]) });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    expect(storage.raw(`${JOB_HISTORY_KEY_PREFIX}${IDENTITY}`)).toBeNull();
  });

  it('does nothing without an identity', () => {
    const storage = memoryStorage(legacySeed([job()]));
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory('');
    expect(storage.raw(`${JOB_HISTORY_KEY_PREFIX}`)).toBeNull();
  });
});

describe('purgeJobHistory (logout)', () => {
  const IDENTITY = 'a'.repeat(64);
  const OTHER_IDENTITY = 'b'.repeat(64);

  it('deletes that identity’s rows and nobody else’s', () => {
    const storage = memoryStorage();
    const store = createJobHistoryStore(storage);
    store.saveJob(IDENTITY, job({ jobEventId: 'mine' }));
    store.saveJob(OTHER_IDENTITY, job({ jobEventId: 'theirs' }));
    store.purgeJobHistory(IDENTITY);
    expect(storage.raw(`${JOB_HISTORY_KEY_PREFIX}${IDENTITY}`)).toBeNull();
    expect(store.readJobs(IDENTITY)).toEqual([]);
    expect(store.readJobs(OTHER_IDENTITY).map((entry) => entry.jobEventId)).toEqual(['theirs']);
  });

  it('keeps the migration marker, so logging back in does not resurrect the rows', () => {
    const storage = memoryStorage({
      [`${JOB_HISTORY_KEY_PREFIX}SoLanaWa11etAddress`]: JSON.stringify([
        job({ jobEventId: 'old' }),
      ]),
    });
    const store = createJobHistoryStore(storage);
    store.migrateLegacyJobHistory(IDENTITY);
    store.purgeJobHistory(IDENTITY);
    expect(storage.raw(JOB_HISTORY_MIGRATED_KEY)).not.toBeNull();
    store.migrateLegacyJobHistory(IDENTITY);
    expect(store.readJobs(IDENTITY)).toEqual([]);
  });

  it('tells subscribers, so the badge goes dark at once', () => {
    const storage = memoryStorage();
    const store = createJobHistoryStore(storage);
    store.saveJob(IDENTITY, job({ jobEventId: 'mine', unseen: true }));
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.purgeJobHistory(IDENTITY);
    expect(notified).toBe(1);
    expect(store.unseenCount(IDENTITY, 'devnet')).toBe(0);
  });

  it('does not write when there is nothing to delete', () => {
    const store = createJobHistoryStore(memoryStorage());
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.purgeJobHistory(IDENTITY);
    expect(notified).toBe(0);
  });
});
