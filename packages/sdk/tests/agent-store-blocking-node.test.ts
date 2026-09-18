import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAgents, loadAgent, readAgentPublic } from '../src/agent-store';

/**
 * A neighbor's `elisym.yaml` is a path nobody validates, and a FIFO left there
 * does not fail a read - it makes the promise never settle, `catch` never run,
 * and a libuv worker burn for the life of the process.
 *
 * Every fixture here needs a WRITER, and a writer that reopens: without one the
 * mutant does not go red, it HANGS, and a hung run is not a killed mutant. With
 * one it reads the yaml, finds it valid, and differs from the fixed code by a
 * verdict.
 */
/** Saved so a reused vitest worker does not inherit a deleted temp HOME. */
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;

let sandbox: string;
let home: string;
let work: string;
const writers: ReturnType<typeof spawn>[] = [];

function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

/** Feeds valid yaml, reopening after each reader closes, until killed. */
function startWriter(path: string, contents: string): void {
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');
       const loop=()=>{ try { fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(contents)}); } catch {} setImmediate(loop); };
       loop();`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  writers.push(writer);
}

function makeAgent(root: string, name: string, yaml: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elisym.yaml'), yaml, 'utf-8');
  return dir;
}

const VALID_YAML = 'display_name: neighbor\n';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-blocking-'));
  home = join(sandbox, 'home');
  work = join(sandbox, 'work');
  mkdirSync(join(home, '.elisym'), { recursive: true });
  mkdirSync(join(work, '.elisym'), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const writer of writers.splice(0)) {
    // `-0` is not a harmless no-op: `process.kill(-0, …)` signals OUR OWN
    // process group, which is the vitest run.
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
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  if (savedUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = savedUserProfile;
  }
});

describe('an agent directory whose yaml is a node that blocks', () => {
  it('is skipped by listAgents, and the rest of the listing survives', async () => {
    // The anchor lives in the SAME root as the subject: put in the other one it
    // would not tell a skipped neighbor apart from a root that never got
    // scanned, and the fixture would pass on a layout that silently failed to
    // build.
    const root = join(home, '.elisym');
    makeAgent(root, 'anchor', VALID_YAML);
    const blocked = join(root, 'blocked');
    mkdirSync(blocked, { recursive: true });
    const yamlPath = join(blocked, 'elisym.yaml');
    makeFifo(yamlPath);
    startWriter(yamlPath, VALID_YAML);

    const listed = await listAgents(work);

    expect(listed.map((agent) => agent.name)).toEqual(['anchor']);
  });

  it('is refused by readAgentPublic, with a cause the caller can recognize', async () => {
    // The node is a SYMLINK to the FIFO here, not the FIFO itself: that is what
    // makes `lstat` instead of `stat` an observable mistake rather than a
    // stylistic one - `lstat` sees a symlink, calls it harmless, and follows it
    // into the FIFO anyway.
    //
    // And the assertion is on the CAUSE, not on the mere fact of a rejection:
    // rejecting is what this function does by default - on a missing file, or
    // on a payload the strict schema refuses - so "it rejected" would be green
    // for the mutant too.
    const root = join(home, '.elisym');
    const dir = join(root, 'linked');
    mkdirSync(dir, { recursive: true });
    const fifoPath = join(dir, 'fifo');
    makeFifo(fifoPath);
    // Valid against the STRICT schema: `name` is not a field it knows, and a
    // payload it refuses would make the mutant reject on validation instead.
    startWriter(fifoPath, VALID_YAML);
    symlinkSync(fifoPath, join(dir, 'elisym.yaml'));

    await expect(
      readAgentPublic({ name: 'linked', dir, source: 'home', shadowsGlobal: false }),
    ).rejects.toThrow(/pipe, socket or device/);
  });

  it.each([['elisym.yaml'], ['.secrets.json']])(
    'is refused by loadAgent when %s is one',
    async (filename) => {
      // `loadAgent` is the path nearly every command takes - `start`, `wallet`,
      // `profile`, `identity`, the MCP config reader. Guarding only the two
      // listing helpers would have left the busiest reader open, and
      // `.secrets.json` guarded nowhere at all.
      const root = join(home, '.elisym');
      const dir = join(root, 'loaded');
      mkdirSync(dir, { recursive: true });
      const other = filename === 'elisym.yaml' ? '.secrets.json' : 'elisym.yaml';
      writeFileSync(join(dir, other), other === 'elisym.yaml' ? VALID_YAML : '{}', 'utf-8');
      const blocked = join(dir, filename);
      makeFifo(blocked);
      startWriter(blocked, filename === 'elisym.yaml' ? VALID_YAML : '{}');

      await expect(loadAgent('loaded', work)).rejects.toThrow(/pipe, socket or device/);
    },
  );
});
