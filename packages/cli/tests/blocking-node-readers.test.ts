import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobLedger, UsedNonceStore } from '../src/ledger.js';
import { X402JobStore } from '../src/x402/store.js';

/**
 * Every file an agent directory holds, on the paths `elisym start` actually
 * takes - not just the two the first version of this gate covered.
 *
 * The failure is not an error: a FIFO where one of these belongs makes the read
 * never return. The synchronous ones stop the process outright, and they run
 * AFTER the agent has published its capability cards - so the agent sits in
 * discovery as a live paid provider that never answers, prints nothing, and
 * ticks no recovery while the jobs it already took age into the 24-hour
 * "the agent did not recover" cutoff with the customer's money spent.
 *
 * Each fixture needs a WRITER: without one the ungated build HANGS rather than
 * going red, and a hung run has measured nothing. With one it reads a perfectly
 * valid file and differs from the gated build by an answer.
 */
let sandbox: string;
const writers: ReturnType<typeof spawn>[] = [];

function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

/** Writes once and exits. Opening a FIFO for writing waits for a reader. */
function startWriterOnce(path: string, contents: string): void {
  writers.push(
    spawn(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(contents)});`],
      { detached: true, stdio: 'ignore' },
    ),
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-blocking-readers-'));
});

afterEach(() => {
  for (const writer of writers.splice(0)) {
    // `-0` is not a harmless no-op: it signals OUR OWN process group.
    if (writer.pid === undefined) {
      writer.kill('SIGKILL');
      continue;
    }
    try {
      process.kill(-writer.pid);
    } catch {
      writer.kill('SIGKILL');
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('the job ledger', () => {
  it('refuses a path that blocks instead of starting with an empty index', () => {
    // Refused, not skipped: an empty ledger is an empty settlement index, and
    // that index is the whole of "one transaction settles one job". The writer
    // feeds a ledger that names a settlement, so the ungated build comes back
    // with `paymentSignatureOwner('sig-1') === 'job-1'` - measured.
    const path = join(sandbox, '.jobs.json');
    makeFifo(path);
    startWriterOnce(
      path,
      JSON.stringify({
        'job-1': {
          job_id: 'job-1',
          status: 'paid',
          input: 'input',
          input_type: 'text',
          tags: [],
          customer_id: 'customer-1',
          created_at: Date.now(),
          retry_count: 0,
          payment_signature: 'sig-1',
        },
      }),
    );

    expect(() => new JobLedger(path)).toThrow(/pipe, socket or device/);
  });
});

describe('the delegated-pull nonce store', () => {
  it('refuses a path that blocks instead of starting with an empty index', () => {
    // Same reasoning one index over: an empty nonce store is a replayable pull.
    const path = join(sandbox, '.delegation-nonces.json');
    makeFifo(path);
    startWriterOnce(path, JSON.stringify({ 'nonce-1': Date.now() + 60_000 }));

    expect(() => new UsedNonceStore(path)).toThrow(/pipe, socket or device/);
  });
});

describe('the x402 job store', () => {
  it('refuses a path that blocks rather than reading it as a cold start', async () => {
    // Its own comment already says every error but ENOENT must fail closed,
    // because this store is what stops the bridge paying an upstream twice. A
    // blocking node never reaches that `catch` at all.
    const agentDir = join(sandbox, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, '.x402-jobs.json');
    makeFifo(path);
    startWriterOnce(path, JSON.stringify({ 'job-1': { paidAttempts: 1 } }));

    await expect(new X402JobStore(agentDir).paidAttempts('job-1')).rejects.toThrow(
      /pipe, socket or device/,
    );
  });
});
