/**
 * D13 jobs-page network filtering: legacy unstamped local entries are devnet
 * (hidden on mainnet), relay-side entries classify by the MAINNET_EPOCH
 * cutoff, and a matching local devnet-stamped-or-unstamped entry overrides
 * the epoch classification for the same job event.
 */
import type { Job } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { MAINNET_EPOCH_SECS, type StoredJob } from '~/lib/jobHistory';
import { buildJobRows } from '~/routes/Jobs/lib/rows';

const PRE_EPOCH_SECS = MAINNET_EPOCH_SECS - 1000;
const POST_EPOCH_SECS = MAINNET_EPOCH_SECS + 1000;

function localJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    jobEventId: 'job-1',
    agentPubkey: 'agent-1',
    agentName: 'Agent One',
    capability: 'summarize',
    status: 'completed',
    createdAt: PRE_EPOCH_SECS * 1000,
    ...overrides,
  };
}

function relayJob(overrides: Partial<Job> = {}): Job {
  return {
    eventId: 'job-1',
    customer: 'customer-1',
    agentPubkey: 'agent-1',
    capability: 'summarize',
    status: 'success',
    createdAt: PRE_EPOCH_SECS,
    ...overrides,
  };
}

describe('buildJobRows network filtering (D13)', () => {
  it('hides legacy unstamped local entries on mainnet, shows them on devnet', () => {
    const locals = [localJob({ jobEventId: 'legacy' })];

    expect(buildJobRows(locals, [], 'mainnet')).toHaveLength(0);
    expect(buildJobRows(locals, [], 'devnet').map((row) => row.jobEventId)).toEqual(['legacy']);
  });

  it('shows stamped local entries only on their own network', () => {
    const locals = [
      localJob({ jobEventId: 'dev', network: 'devnet' }),
      localJob({ jobEventId: 'main', network: 'mainnet' }),
    ];

    expect(buildJobRows(locals, [], 'devnet').map((row) => row.jobEventId)).toEqual(['dev']);
    expect(buildJobRows(locals, [], 'mainnet').map((row) => row.jobEventId)).toEqual(['main']);
  });

  it('classifies relay-only rows by the MAINNET_EPOCH cutoff', () => {
    const relays = [
      relayJob({ eventId: 'pre', createdAt: PRE_EPOCH_SECS }),
      relayJob({ eventId: 'post', createdAt: POST_EPOCH_SECS }),
    ];

    expect(buildJobRows([], relays, 'devnet').map((row) => row.jobEventId)).toEqual(['pre']);
    expect(buildJobRows([], relays, 'mainnet').map((row) => row.jobEventId)).toEqual(['post']);
  });

  it('lets a local devnet entry override a post-epoch relay classification', () => {
    // A stale pre-flip tab submitted a devnet job after the epoch: the relay
    // event alone would classify as mainnet, but the local trace (unstamped
    // or devnet-stamped) is the better witness - hidden on mainnet, shown on
    // devnet as a merged row.
    const relays = [relayJob({ eventId: 'stale-tab', createdAt: POST_EPOCH_SECS })];
    const unstamped = [localJob({ jobEventId: 'stale-tab', status: 'pending' })];
    const stamped = [localJob({ jobEventId: 'stale-tab', status: 'pending', network: 'devnet' })];

    for (const locals of [unstamped, stamped]) {
      expect(buildJobRows(locals, relays, 'mainnet')).toHaveLength(0);

      const devnetRows = buildJobRows(locals, relays, 'devnet');
      expect(devnetRows).toHaveLength(1);
      expect(devnetRows[0]?.source).toBe('merged');
      expect(devnetRows[0]?.status).toBe('completed');
    }
  });

  it('lets a local mainnet entry claim its relay row on mainnet only', () => {
    const relays = [relayJob({ eventId: 'main-job', createdAt: POST_EPOCH_SECS })];
    const locals = [localJob({ jobEventId: 'main-job', network: 'mainnet' })];

    expect(buildJobRows(locals, relays, 'devnet')).toHaveLength(0);

    const mainnetRows = buildJobRows(locals, relays, 'mainnet');
    expect(mainnetRows).toHaveLength(1);
    expect(mainnetRows[0]?.source).toBe('merged');
  });
});
