import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureGitignoreHasIrohEntry,
  hashFile,
  isBlockingNode,
  isBlockingNodeSync,
  listAgents,
  loadAgent,
  loadPoliciesFromDir,
  readAgentPublic,
  readMediaCache,
  writeSecrets,
} from '../src/agent-store';
import { loadGlobalConfig } from '../src/config/global';
import { loadSkillsFromDir } from '../src/skills';
import { StaticFileSkill } from '../src/skills/staticFileSkill';

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

/**
 * Writes ONCE and exits. Opening a FIFO for writing blocks until a reader
 * arrives, so a single write still meets whatever read comes - and unlike the
 * reopening writer above it cannot deliver the payload twice, which is what a
 * JSON reader would choke on (measured: with the looping writer the mutant
 * parsed a concatenation, failed, and answered `{}` like the fixed code).
 */
function startWriterOnce(path: string, contents: string): void {
  const writer = spawn(
    process.execPath,
    ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(contents)});`],
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
/** Named per skill, so the two in the fixture below are told apart by NAME. */
function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: a skill for the fixture\ncapabilities: [text-gen]\nprice: 1000000\n---\n\nBody.\n`;
}
const VALID_POLICY_MD = '---\ntitle: Terms of Service\nversion: "1.0"\n---\n\nBody.\n';

const sockets: Server[] = [];

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
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
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

  it('follows a symlink in the SYNCHRONOUS form too, not only the async one', () => {
    // `statSync`, not `lstatSync`: the async half has a fixture for this
    // (`readAgentPublic` through a symlinked FIFO) and the sync half did not,
    // though the same sentence in the module docstring covers both - and the
    // sync readers are the ones that stop the whole process.
    const target = join(sandbox, 'fifo-target');
    makeFifo(target);
    const link = join(sandbox, 'link-to-fifo');
    symlinkSync(target, link);

    expect(isBlockingNodeSync(link)).toBe(true);
  });

  it('answers false for what it cannot stat at all, so it only ever NARROWS', async () => {
    // The invariant the module's own docstring rests on: every throw inside it
    // means "the gate did not fire", and the read that follows fails exactly as
    // it does today. Inverted, a missing file would read as a blocking node and
    // every first run of every agent would refuse to start.
    expect(await isBlockingNode(join(sandbox, 'nothing-here'))).toBe(false);
    expect(isBlockingNodeSync(join(sandbox, 'nothing-here'))).toBe(false);
  });

  it('is not only about pipes: a socket is refused the same way', async () => {
    // The gate names four node types and only the FIFO ones are reachable from
    // a fixture - a character or block device needs root. A unix socket does
    // not, so at least the second disjunct is measured rather than asserted in
    // a comment. The path is kept SHORT deliberately: the sun_path limit is
    // about a hundred characters, and a temp directory eats most of it.
    const path = join(sandbox, 's');
    const server = createServer();
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    expect(await isBlockingNode(path)).toBe(true);
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

/**
 * The other three files an agent directory holds. `elisym.yaml` and
 * `.secrets.json` were gated first, and gating only those left `elisym start`
 * reading each of these on the way up - two of them SYNCHRONOUSLY, which does
 * not burn a worker but stops the process outright, before any timeout anyone
 * set can fire. Measured: a FIFO in any of these three hangs the start.
 */
describe('the rest of the files an agent directory holds', () => {
  it('skips a skill whose SKILL.md blocks, and loads the rest', () => {
    const skills = join(sandbox, 'skills');
    mkdirSync(join(skills, 'good'), { recursive: true });
    writeFileSync(join(skills, 'good', 'SKILL.md'), skillMd('good'), 'utf-8');
    const pipedDir = join(skills, 'piped');
    mkdirSync(pipedDir, { recursive: true });
    const piped = join(pipedDir, 'SKILL.md');
    makeFifo(piped);
    // The writer feeds a VALID skill, so the mutant loads two and the fixed
    // code loads one: the two differ by a result, not by a hang.
    startWriter(piped, skillMd('piped'));

    const loaded = loadSkillsFromDir(skills, { network: 'devnet' });

    expect(loaded.map((skill) => skill.name)).toEqual(['good']);
  });

  it('skips a policy that blocks, and loads the rest', () => {
    const dir = join(sandbox, 'policies');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tos.md'), VALID_POLICY_MD, 'utf-8');
    const piped = join(dir, 'privacy.md');
    makeFifo(piped);
    startWriter(piped, VALID_POLICY_MD);

    const loaded = loadPoliciesFromDir(dir);

    expect(loaded.map((policy) => policy.type)).toEqual(['tos']);
  });

  it('refuses the global config rather than reading defaults off a node', async () => {
    // `~/.elisym/config.yaml` sits in the same root, is read at MCP startup, and
    // its own `catch` treats only ENOENT as an absence - which a blocking node
    // never reaches, because the read never settles.
    const root = join(sandbox, 'global-config');
    mkdirSync(root, { recursive: true });
    const piped = join(root, 'config.yaml');
    makeFifo(piped);
    startWriterOnce(piped, 'relays:\n  - wss://relay.example.invalid\n');

    await expect(loadGlobalConfig(piped)).rejects.toThrow(/pipe, socket or device/);
  });

  it("refuses to hash a picture that blocks, which is how it reaches the agent's yaml", async () => {
    // The path comes out of `elisym.yaml` - a picture or a banner - and nobody
    // validates its node type. `lookupCachedUrl` turns this into "not cached",
    // which is what an unreadable file already gets.
    const dir = join(sandbox, 'media');
    mkdirSync(dir, { recursive: true });
    const piped = join(dir, 'banner.png');
    makeFifo(piped);
    startWriterOnce(piped, 'not really a png, but readable');

    await expect(hashFile(piped)).rejects.toThrow(/pipe, socket or device/);
  });

  it('writes secrets through a temporary nobody can guess', async () => {
    // `writeFileAtomic` is the writer behind `.secrets.json` and `elisym.yaml`,
    // and its random suffix is the only thing standing between a planted FIFO
    // and a write that never returns - or, with the pipe drained, a rename that
    // puts somebody else's node where the agent's KEYS belong.
    const dir = join(sandbox, 'secret-agent');
    mkdirSync(dir, { recursive: true });
    const guessed = join(dir, '.secrets.json.tmp');
    makeFifo(guessed);
    startDrainer(guessed);

    await writeSecrets(dir, { nostr_secret_key: 'a'.repeat(64) });

    expect(statSync(join(dir, '.secrets.json')).isFile()).toBe(true);
    expect(statSync(guessed).isFIFO()).toBe(true);
  });

  it('leaves a .gitignore that blocks exactly as it found it', async () => {
    // The write path rather than the start path, and the same class: this runs
    // while an agent is being created, in a `.elisym` root a project may share.
    // Without the gate the read never settles - and if it did, the entry-adding
    // write would rename a regular file over the node.
    const root = join(sandbox, 'root-with-gitignore');
    mkdirSync(root, { recursive: true });
    const piped = join(root, '.gitignore');
    makeFifo(piped);
    startWriter(piped, 'node_modules\n');

    // Raced against a timer, and the assertion is that the call RETURNED.
    // Everything else in this file can measure a verdict instead, because a
    // reader answers something; here the ungated path hangs on the write side
    // too - opening a FIFO for writing blocks until somebody reads it - so
    // "hung" IS the observable, and racing it is what turns it into a red
    // assertion in two seconds instead of a suite that dies of its timeout.
    const finished = await Promise.race([
      ensureGitignoreHasIrohEntry(root).then(() => 'returned' as const),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => resolve('hung'), 2_000);
      }),
    ]);

    expect(finished).toBe('returned');
    expect(statSync(piped).isFIFO()).toBe(true);
  });

  it('reads an empty media cache rather than waiting on one that blocks', async () => {
    const dir = join(sandbox, 'agent-with-cache');
    mkdirSync(dir, { recursive: true });
    const piped = join(dir, '.media-cache.json');
    makeFifo(piped);
    // Valid content again: the mutant comes back with this entry, the fixed
    // code with an empty cache.
    // Valid against the STRICT schema - a payload it rejects collapses to `{}`
    // as well, and the fixture would pass against the mutant too. Measured.
    startWriterOnce(
      piped,
      JSON.stringify({
        'file.png': {
          url: 'https://example.invalid/x.png',
          sha256: 'a'.repeat(64),
          uploaded_at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    expect(await readMediaCache(dir)).toEqual({});
  });
});

describe('a static-file skill whose output_file blocks', () => {
  it('refuses to execute rather than hand a paying customer a hung read', async () => {
    // `StaticFileSkill` is exported and the loader suite already executes this
    // mode - an earlier round marked the gate "never through an execution",
    // which was wrong, and a false "not covered" note tells the next reader not
    // to look.
    // `realpathSync` on the sandbox: on macOS `tmpdir()` lives behind a symlink,
    // and the skill's own escape check resolves both sides - without this the
    // fixture dies on "escapes the skill directory" and never reaches the gate.
    const skillDir = join(realpathSync(sandbox), 'skills', 'report');
    mkdirSync(skillDir, { recursive: true });
    const outputFilePath = join(skillDir, 'out.txt');
    makeFifo(outputFilePath);
    startWriterOnce(outputFilePath, 'the paid result');

    const skill = new StaticFileSkill({
      name: 'report',
      description: 'd',
      capabilities: ['c'],
      priceSubunits: 0n,
      asset: { kind: 'native', symbol: 'SOL', decimals: 9 } as never,
      outputFilePath,
      skillDir,
    });

    await expect(skill.execute({} as never, {} as never)).rejects.toThrow(/pipe, socket or device/);
  });
});
