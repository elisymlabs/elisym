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
    expect(store.unseenCount(WALLET)).toBe(0);
  });

  it('clearUnseen scopes to an agent and skips the write when nothing is set', () => {
    const store = createJobHistoryStore(memoryStorage());
    store.saveJob(WALLET, job({ jobEventId: 'a', agentPubkey: 'agent-1', status: 'pending' }));
    store.saveJob(WALLET, job({ jobEventId: 'b', agentPubkey: 'agent-2', status: 'pending' }));
    store.flipTerminal(WALLET, 'a', { status: 'completed' }, { stampUnseen: true });
    store.flipTerminal(WALLET, 'b', { status: 'completed' }, { stampUnseen: true });
    expect(store.unseenCount(WALLET)).toBe(2);

    store.clearUnseen(WALLET, 'agent-1');
    expect(store.unseenCount(WALLET)).toBe(1);
    expect(store.readJobs(WALLET).find((entry) => entry.jobEventId === 'b')?.unseen).toBe(true);

    store.clearUnseen(WALLET);
    expect(store.unseenCount(WALLET)).toBe(0);

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
});
