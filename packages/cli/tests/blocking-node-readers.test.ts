import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElisymIdentity, toDTag } from '@elisym/sdk';
import type { BlobDescriptor, BlossomService } from '@elisym/sdk';
import type { MediaCache } from '@elisym/sdk/agent-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { uploadOrReuse } from '../src/commands/start.js';
import { scanExistingSkills } from '../src/commands/x402-add.js';
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

/** Drains a FIFO forever, so a WRITE to one returns instead of blocking. */
function startDrainer(path: string): void {
  writers.push(
    spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');
         const loop=()=>{ try { fs.readFileSync(${JSON.stringify(path)}); } catch {} setImmediate(loop); };
         loop();`,
      ],
      { detached: true, stdio: 'ignore' },
    ),
  );
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

/** A FIFO plus a one-shot writer, the pair every fixture here needs. */
function fifoWith(path: string, contents: string): void {
  makeFifo(path);
  startWriterOnce(path, contents);
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

/**
 * The other half of the same class. Reading a blocking node is gated by node
 * type; WRITING one is protected by there being nothing to plant - every
 * temporary this process writes through carries a random suffix.
 *
 * Each fixture plants a FIFO at the name the code used to use and a DRAINER
 * beside it, so the unfixed build does not hang: it writes into the pipe, the
 * drainer empties it, the rename then puts the FIFO where the file belongs, and
 * the fixture goes red on its assertion instead of on the clock.
 */
describe('a temporary file somebody else can guess', () => {
  it('cannot swallow a settlement claim on its way to the job ledger', () => {
    const path = join(sandbox, '.jobs.json');
    const ledger = new JobLedger(path);
    ledger.recordPaid({
      job_id: 'job-1',
      input: 'input',
      input_type: 'text',
      tags: [],
      customer_id: 'customer-1',
      created_at: Math.floor(Date.now() / 1000),
    } as never);
    const guessed = `${path}.tmp`;
    makeFifo(guessed);
    startDrainer(guessed);

    expect(ledger.claimPaymentSignature('sig-1', 'job-1')).toBe('claimed');

    // The claim is on DISK, which is what `claimed` promises: a fresh ledger
    // reads it back. With a guessable temporary the write went into the pipe
    // and the rename left a FIFO where the ledger belongs.
    expect(new JobLedger(path).paymentSignatureOwner('sig-1')).toBe('job-1');
    expect(statSync(guessed).isFIFO()).toBe(true);
  });

  it('cannot swallow a delegated-pull nonce', () => {
    const path = join(sandbox, '.delegation-nonces.json');
    const store = new UsedNonceStore(path);
    const guessed = `${path}.tmp`;
    makeFifo(guessed);
    startDrainer(guessed);

    store.markUsed('nonce-1', Math.floor(Date.now() / 1000) + 3600);

    expect(new UsedNonceStore(path).has('nonce-1')).toBe(true);
    expect(statSync(guessed).isFIFO()).toBe(true);
  });
});

describe('an x402 job index written through a guessable temporary', () => {
  it('cannot lose the paid-attempt count that stops a second payment', async () => {
    // The counter this store keeps is what caps how many times the bridge may
    // pay an upstream for one job. A write that goes into a planted pipe leaves
    // it at zero, and the next attempt pays again.
    const agentDir = join(sandbox, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const store = new X402JobStore(agentDir);
    const guessed = join(agentDir, '.x402-jobs.json.tmp');
    makeFifo(guessed);
    startDrainer(guessed);

    await store.claimPaidAttempt('job-1', 2, 2);

    expect(await new X402JobStore(agentDir).paidAttempts('job-1')).toBe(1);
    expect(statSync(guessed).isFIFO()).toBe(true);
  });
});

describe('an x402 result path somebody can guess', () => {
  it('cannot swallow a result the upstream was already paid for', async () => {
    // The final name is derived from the job id, which is a public Nostr event
    // id - so this path is guessable, unlike a random temporary. And the write
    // happens AFTER the upstream has been paid: a hang here strands the job with
    // the money gone, while a drained pipe is worse still, because the record
    // then reads as attempt-without-result and the bridge pays again.
    const agentDir = join(sandbox, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const store = new X402JobStore(agentDir);
    const resultPath = join(agentDir, '.x402-results', 'job-1');
    mkdirSync(join(agentDir, '.x402-results'), { recursive: true });
    makeFifo(resultPath);
    startDrainer(resultPath);

    await store.saveFileResult('job-1', 'image/png', new Uint8Array([1, 2, 3]));

    // The bytes are on disk and the record points at them. `rename` REPLACES
    // the planted node rather than opening it, which is why the fix works at
    // all: the only blocking operation here was the write, and it now goes to a
    // name nobody can guess.
    expect(await store.getResult('job-1')).toMatchObject({ outputMime: 'image/png' });
    expect(statSync(resultPath).isFile()).toBe(true);
    expect(readFileSync(resultPath)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('a job ledger that cannot be READ', () => {
  it.each([
    ['the job ledger', '.jobs.json', (path: string) => new JobLedger(path)],
    ['the nonce store', '.delegation-nonces.json', (path: string) => new UsedNonceStore(path)],
  ])(
    '%s is refused rather than rotated aside and replaced with an empty one',
    (_label, filename, open) => {
      // EACCES, EISDIR, EIO: we did not read the file, so we do not know what it
      // records - and starting empty frees every settlement in it. Only a file
      // that was READ and could not be PARSED is rotated and replaced.
      if (process.getuid?.() === 0) {
        return; // root ignores the mode bits
      }
      const path = join(sandbox, filename);
      writeFileSync(
        path,
        JSON.stringify({ 'job-1': { job_id: 'job-1', payment_signature: 'sig-1' } }),
      );
      chmodSync(path, 0o000);

      try {
        expect(() => open(path)).toThrow(/cannot be read/);
        // And the evidence is still where it was: rotating it aside would move
        // the only record of which transaction paid for which job.
        expect(statSync(path).isFile()).toBe(true);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );
});

describe('the picture an agent advertises', () => {
  it('is skipped when it is a blocking node, instead of being uploaded', async () => {
    // `uploadOrReuse` is exported and has its own harness - a previous round
    // marked this gate "no fixture drives `cmdStart`", which was true of the
    // COMMAND and false of the function.
    const filePath = join(sandbox, 'hero.png');
    fifoWith(filePath, 'fake-image-bytes-for-test');
    const upload = vi.fn(
      async (): Promise<BlobDescriptor> => ({
        url: 'https://files.elisym.network/abc.png',
        sha256: 'a'.repeat(64),
        size: 25,
        type: 'image/png',
        provider: 'blossom',
      }),
    );
    const blossom: Pick<BlossomService, 'upload'> = { upload };
    const cache: MediaCache = {};

    const url = await uploadOrReuse(
      'picture',
      filePath,
      sandbox,
      cache,
      blossom,
      ElisymIdentity.generate(),
      vi.fn(),
    );

    expect(url).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('the d-tag collision scan of `elisym x402 add`', () => {
  it('cannot see a collision through a SKILL.md that blocks, and says so', () => {
    // Exported, and `x402-add.test.ts` already drives it directly. The gate
    // answers by skipping, which is a hole in the collision answer rather than
    // one missing skill - hence the warning line beside it.
    const skillsDir = join(sandbox, 'skills');
    mkdirSync(join(skillsDir, 'piped'), { recursive: true });
    // An ordinary neighbor, so the scan has something real to walk past.
    mkdirSync(join(skillsDir, 'plain'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'plain', 'SKILL.md'),
      ['---', 'name: Other Skill', 'description: d', 'capabilities:', '  - c', '---', ''].join(
        '\n',
      ),
    );
    fifoWith(
      join(skillsDir, 'piped', 'SKILL.md'),
      ['---', 'name: WHOIS Lookup', 'description: d', 'capabilities:', '  - c', '---', ''].join(
        '\n',
      ),
    );

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    let scan: ReturnType<typeof scanExistingSkills>;
    try {
      scan = scanExistingSkills(skillsDir, toDTag('whois-lookup'), 'https://x.example/a');
    } finally {
      warn.mockRestore();
    }

    expect(scan).toEqual({});
    // And it SAYS it could not look: a skill this scan cannot read is a hole in
    // the collision answer, not one missing skill.
    expect(warnings.join('\n')).toContain('name collision');
  });
});
