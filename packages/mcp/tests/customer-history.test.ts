import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMER_HISTORY_FILENAME,
  MAX_HISTORY_ENTRIES,
  appendCustomerJob,
  findCustomerJob,
  findCustomerJobsByProvider,
  readCustomerHistory,
  updateCustomerJob,
  type CustomerJobEntry,
} from '../src/storage/customer-history';

let sandbox: string;
let agentDir: string;

const PROVIDER_A = 'a'.repeat(64);
const PROVIDER_B = 'b'.repeat(64);

function makeEntry(overrides: Partial<CustomerJobEntry> = {}): CustomerJobEntry {
  return {
    jobEventId: 'job-1',
    capability: 'translate',
    providerPubkey: PROVIDER_A,
    status: 'completed',
    submittedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    ...overrides,
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-customer-history-'));
  agentDir = join(sandbox, 'agent');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('customer-history', () => {
  it('returns empty history when file is missing', async () => {
    const history = await readCustomerHistory(agentDir);
    expect(history).toEqual({ version: 1, jobs: [] });
  });

  it('round-trips a job through append + read', async () => {
    const entry = makeEntry({ paymentSig: 'sig-xyz', resultPreview: 'hi' });
    await appendCustomerJob(agentDir, entry);
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(1);
    expect(history.jobs[0]).toMatchObject({
      jobEventId: 'job-1',
      paymentSig: 'sig-xyz',
      resultPreview: 'hi',
    });
  });

  it('writes the file at the expected path', async () => {
    await appendCustomerJob(agentDir, makeEntry());
    const path = join(agentDir, CUSTOMER_HISTORY_FILENAME);
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(1);
    expect(path.endsWith('.customer-history.json')).toBe(true);
  });

  it('replaces an entry on duplicate jobEventId instead of appending', async () => {
    await appendCustomerJob(agentDir, makeEntry({ status: 'completed' }));
    await appendCustomerJob(agentDir, makeEntry({ status: 'failed' }));
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(1);
    expect(history.jobs[0]!.status).toBe('failed');
  });

  it('trims oldest entries when count exceeds MAX_HISTORY_ENTRIES', async () => {
    const writes = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) =>
      appendCustomerJob(
        agentDir,
        makeEntry({
          jobEventId: `job-${index}`,
          submittedAt: 1_700_000_000_000 + index,
          completedAt: 1_700_000_000_000 + index + 1,
        }),
      ),
    );
    for (const write of writes) {
      await write;
    }
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs.length).toBe(MAX_HISTORY_ENTRIES);
    const oldest = Math.min(...history.jobs.map((entry) => entry.submittedAt));
    expect(oldest).toBe(1_700_000_000_005);
  });

  it('preserves all entries under concurrent appends', async () => {
    const total = 30;
    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        appendCustomerJob(
          agentDir,
          makeEntry({
            jobEventId: `concurrent-${index}`,
            submittedAt: 1_700_000_000_000 + index,
          }),
        ),
      ),
    );
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(total);
    const ids = new Set(history.jobs.map((entry) => entry.jobEventId));
    expect(ids.size).toBe(total);
  });

  it('updateCustomerJob patches an existing entry', async () => {
    await appendCustomerJob(agentDir, makeEntry());
    await updateCustomerJob(agentDir, 'job-1', { customerFeedback: 'positive' });
    const found = await findCustomerJob(agentDir, 'job-1');
    expect(found?.customerFeedback).toBe('positive');
    expect(found?.status).toBe('completed');
  });

  it('updateCustomerJob is a no-op when the entry is missing', async () => {
    await updateCustomerJob(agentDir, 'nope', { customerFeedback: 'positive' });
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(0);
  });

  it('findCustomerJobsByProvider returns matching entries newest-first', async () => {
    await appendCustomerJob(
      agentDir,
      makeEntry({ jobEventId: 'old', completedAt: 1_700_000_000_000, providerPubkey: PROVIDER_A }),
    );
    await appendCustomerJob(
      agentDir,
      makeEntry({ jobEventId: 'new', completedAt: 1_700_000_005_000, providerPubkey: PROVIDER_A }),
    );
    await appendCustomerJob(
      agentDir,
      makeEntry({ jobEventId: 'other', providerPubkey: PROVIDER_B }),
    );
    const results = await findCustomerJobsByProvider(agentDir, PROVIDER_A);
    expect(results.map((entry) => entry.jobEventId)).toEqual(['new', 'old']);
  });

  it('returns an empty history when the file is corrupt', async () => {
    await appendCustomerJob(agentDir, makeEntry());
    const path = join(agentDir, CUSTOMER_HISTORY_FILENAME);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json', 'utf-8');
    const history = await readCustomerHistory(agentDir);
    expect(history.jobs).toHaveLength(0);
  });
});
