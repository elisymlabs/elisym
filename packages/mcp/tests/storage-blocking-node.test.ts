/**
 * The customer-side stores read files inside an agent directory, so they owe
 * the same node-type gate every other reader of those files pays.
 *
 * Two measurements sit behind this file. A FIFO where one of these belongs
 * makes the read never settle - and the read happens INSIDE the per-path write
 * lock, whose queue is `previous.then(fn, fn)`, so a promise that never settles
 * jams every later write to that file for the life of the process. Measured:
 * after one such read, an append still hung with the node already deleted and
 * an ordinary file in its place. `submit_and_pay_job` appends to the history
 * AFTER the payment lands, so the customer's money is gone and the tool call
 * never returns.
 *
 * Each fixture needs a WRITER: without one the ungated build HANGS rather than
 * going red, and a hung run has measured nothing.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureIrohTransport } from '../src/iroh.js';
import { readContacts, upsertContact } from '../src/storage/contacts.js';
import { appendCustomerJob, readCustomerHistory } from '../src/storage/customer-history.js';
import { listJobSessions, recordSessionSubmit } from '../src/storage/job-sessions.js';
import { advanceReadCursor, readReadCursors } from '../src/storage/read-cursors.js';

let sandbox: string;
let agentDir: string;
const writers: ReturnType<typeof spawn>[] = [];

function fifoWith(path: string, contents: string): void {
  execFileSync('mkfifo', [path]);
  writers.push(
    spawn(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(contents)});`],
      { detached: true, stdio: 'ignore' },
    ),
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-mcp-blocking-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
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

describe('a customer-side store whose file is a node that blocks', () => {
  it('reads an empty history rather than waiting on one', async () => {
    // The writer feeds a VALID history, so the ungated build comes back with
    // that job in it: the two differ by an answer, not by a hang.
    // Valid against the STRICT schema: a payload it refuses collapses to an
    // empty history as well, and the fixture would then pass against the
    // ungated build too - measured, that is exactly what the first version did.
    fifoWith(
      join(agentDir, '.customer-history.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            jobEventId: 'e'.repeat(64),
            capability: 'text-gen',
            providerPubkey: 'a'.repeat(64),
            status: 'completed',
            submittedAt: 1,
            completedAt: 2,
          },
        ],
      }),
    );

    expect((await readCustomerHistory(agentDir)).jobs).toEqual([]);
  });

  it('reads an empty contact list rather than waiting on one', async () => {
    fifoWith(
      join(agentDir, '.contacts.json'),
      JSON.stringify({
        version: 1,
        contacts: [{ pubkey: 'a'.repeat(64), npub: 'npub1bob', addedAt: 1 }],
      }),
    );

    expect((await readContacts(agentDir)).contacts).toEqual([]);
  });

  it('reads an empty job-session list rather than waiting on one', async () => {
    // The fourth of the four gates, and the one shaped differently: it sits
    // after the in-memory branch, so it needs its own row rather than riding on
    // a neighbour's. The payload is valid against the strict schema (a v4
    // session id, a 64-hex pubkey) - one that is not collapses to empty on both
    // sides and measures nothing.
    fifoWith(
      join(agentDir, '.job-sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c',
            providerPubkey: 'a'.repeat(64),
            capability: 'text-gen',
            createdAt: 1,
            lastUsedAt: 2,
            turnCount: 1,
            firstPrompt: 'hello',
            jobIds: ['e'.repeat(64)],
          },
        ],
      }),
    );

    expect(await listJobSessions({ agentDir, identityPubkey: 'b'.repeat(64) }, 10)).toEqual([]);
  });

  it('reads empty DM cursors rather than waiting on them', async () => {
    fifoWith(
      join(agentDir, '.messages-read.json'),
      JSON.stringify({ version: 1, cursors: { ['b'.repeat(64)]: 42 } }),
    );

    expect(await readReadCursors(agentDir)).toEqual({});
  });
});

describe('the blob store a file transfer opens', () => {
  it('is added to an older .gitignore when a transport is asked for', async () => {
    // `.iroh/` holds job inputs and bought results in the CLEAR. `elisym start`
    // is the only other place this migration runs, and an agent used purely as
    // a customer through MCP never starts. The assertion is on the `.gitignore`
    // and not on the transport, so this does not need the native addon.
    //
    // THAT it runs, not that it runs first: `createIrohTransport` is lazy and
    // touches no disk until the node is opened, so moving the migration after
    // it changes nothing observable. The name said otherwise until it was
    // measured.
    const root = join(sandbox, '.elisym');
    writeFileSync(join(root, '.gitignore'), '.secrets.json\n', 'utf-8');

    await ensureIrohTransport({ agentDir } as never).catch(() => undefined);

    expect(readFileSync(join(root, '.gitignore'), 'utf-8').split('\n')).toContain('.iroh/');
  });
});

describe('the .gitignore an older agent directory carries', () => {
  it.each([
    [
      'the customer history',
      async (dir: string) => {
        await appendCustomerJob(dir, {
          jobEventId: 'e'.repeat(64),
          capability: 'text-gen',
          providerPubkey: 'a'.repeat(64),
          status: 'completed',
          submittedAt: 1,
          completedAt: 2,
        });
      },
      '.customer-history.json*',
    ],
    [
      'the contact list',
      async (dir: string) => {
        await upsertContact(dir, { pubkey: 'a'.repeat(64), npub: 'npub1bob' });
      },
      '.contacts.json*',
    ],
    [
      'the DM read cursors',
      async (dir: string) => {
        await advanceReadCursor(dir, 'b'.repeat(64), 42);
      },
      '.messages-read.json*',
    ],
    [
      'the job-session list',
      async (dir: string) => {
        await recordSessionSubmit(
          { agentDir: dir, identityPubkey: 'b'.repeat(64) },
          {
            sessionId: '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c',
            providerPubkey: 'a'.repeat(64),
            capability: 'text-gen',
            firstPrompt: 'hello',
            jobEventId: 'e'.repeat(64),
          },
        );
      },
      '.job-sessions.json*',
    ],
  ])('is widened when %s is written', async (_label, write, entry) => {
    // These files are written through a temporary whose suffix is random, and
    // an agent created by an older build has the bare name in its `.gitignore`
    // - which cannot match one. The write site is where the migration has to
    // run, because nothing else in an MCP process does it.
    //
    // This row measures THAT the migration runs; the row in
    // `storage-write-order.test.ts` measures that it runs FIRST, by watching
    // the calls rather than by forcing a failure.
    const root = join(sandbox, '.elisym');
    writeFileSync(join(root, '.gitignore'), '.secrets.json\n', 'utf-8');

    await write(agentDir);

    expect(readFileSync(join(root, '.gitignore'), 'utf-8').split('\n')).toContain(entry);
  });
});
