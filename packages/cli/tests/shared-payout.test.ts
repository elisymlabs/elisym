import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteControlCharacters } from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSharedPayoutNeighbors } from '../src/helpers.js';

/**
 * `HOME` and the project root are DIFFERENT directories here, and that is
 * load-bearing rather than tidy: `findProjectElisymDir` stops at `$HOME` before
 * it looks for `.elisym` in the current directory, so with `HOME === cwd` no
 * project root is found at all. The listing does not go empty - the home root
 * is scanned unconditionally and would be the same directory - but
 * `shadowsGlobal` is then always false, and every shadowing and de-duplication
 * fixture below would quietly stop testing what it was written for.
 */
const ADDRESS = 'DLZ1JYbYLEe4QowxxuNtGEzeYkJiSqmNHZhQSiAfzHms';
const OTHER_ADDRESS = 'JAJY3XFw5RJXQBjWG4VSTFVXaW53FvxDeve1kVbVJZYD';

/** Saved so a reused vitest worker does not inherit a deleted temp HOME. */
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;

let sandbox: string;
let home: string;
let work: string;
let homeRoot: string;
let projectRoot: string;

function yamlFor(address: string, network = 'devnet'): string {
  return `display_name: agent\npayments:\n  - chain: solana\n    address: ${address}\n    network: ${network}\n`;
}

/** An agent directory with one paid skill, unless `paid` says otherwise. */
function makeAgent(
  root: string,
  name: string,
  options: { address?: string; network?: string; paid?: boolean; skills?: boolean } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'elisym.yaml'),
    yamlFor(options.address ?? ADDRESS, options.network ?? 'devnet'),
    'utf-8',
  );
  if (options.skills !== false) {
    const skillDir = join(dir, 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    const price = options.paid === false ? '0' : '1000000';
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: demo\ndescription: a demo skill for the fixture\ncapabilities: [text-gen]\nprice: ${price}\n---\n\nBody.\n`,
      'utf-8',
    );
  }
  return dir;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-shared-payout-'));
  home = join(sandbox, 'home');
  work = join(sandbox, 'work');
  homeRoot = join(home, '.elisym');
  projectRoot = join(work, '.elisym');
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

const writers: ReturnType<typeof spawn>[] = [];

/** Feeds a valid paid SKILL.md, reopening after each reader closes. */
function startWriter(path: string, contents: string): void {
  writers.push(
    spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');
         const loop=()=>{ try { fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(contents)}); } catch {} setImmediate(loop); };
         loop();`,
      ],
      { detached: true, stdio: 'ignore' },
    ),
  );
}

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

describe('agents that would be paid at the same address', () => {
  it('names a neighbor sharing the pair', async () => {
    const own = makeAgent(projectRoot, 'starter');
    makeAgent(homeRoot, 'neighbor');

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => entry.name)).toEqual(['neighbor']);
    expect(found[0]?.paid).toBe(true);
  });

  it('excludes the starting agent by DIRECTORY, both sides dereferenced', async () => {
    // On macOS `tmpdir()` itself lives behind a symlink, so comparing a
    // resolved path against a raw one diverges here every time and in
    // production almost never - which is how the bug survives review. The
    // anchor is what proves the layout built at all.
    const own = makeAgent(homeRoot, 'starter');
    makeAgent(homeRoot, 'anchor');

    const found = await findSharedPayoutNeighbors(work, realpathSync(own), 'devnet', ADDRESS);

    expect(found.map((entry) => entry.name)).toEqual(['anchor']);
  });

  it('does not exclude a same-named agent living in the other root', async () => {
    // Excluding by NAME would drop this one, and a same-named agent in another
    // root is a real neighbor.
    const own = makeAgent(projectRoot, 'alice');
    makeAgent(homeRoot, 'alice');

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => entry.name)).toEqual(['alice']);
    expect(found[0]?.dir).toContain(join('home', '.elisym', 'alice'));
  });

  it('counts one physical directory once when a root is a symlink to the other', async () => {
    const own = makeAgent(homeRoot, 'starter');
    makeAgent(homeRoot, 'neighbor');
    rmSync(projectRoot, { recursive: true, force: true });
    symlinkSync(homeRoot, projectRoot);

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => entry.name)).toEqual(['neighbor']);
  });

  it('ignores a different address and a different network', async () => {
    const own = makeAgent(projectRoot, 'starter');
    makeAgent(homeRoot, 'elsewhere', { address: OTHER_ADDRESS });
    makeAgent(homeRoot, 'mainnet-twin', { network: 'mainnet' });

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found).toEqual([]);
  });

  it('ignores a neighbor with nothing paid', async () => {
    const own = makeAgent(projectRoot, 'starter');
    makeAgent(homeRoot, 'free-only', { paid: false });

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found).toEqual([]);
  });

  it("says 'unknown' rather than nothing when it could not read skills", async () => {
    // The loader collapses "unreadable" and "no paid skills" into the same
    // empty list, so counting the denominator ourselves is the only thing that
    // separates them. Here a subdirectory exists whose SKILL.md is a directory:
    // EISDIR, which is a signal.
    const own = makeAgent(projectRoot, 'starter');
    const neighbor = makeAgent(homeRoot, 'opaque', { paid: false });
    mkdirSync(join(neighbor, 'skills', 'broken', 'SKILL.md'), { recursive: true });

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => [entry.name, entry.paid])).toEqual([['opaque', 'unknown']]);
  });

  it("says 'unknown' when the skills directory cannot be OPENED at all", async () => {
    // The row above reaches the directory and stumbles inside it. This one
    // cannot open it: EACCES on `readdir`, which says something about OUR
    // process, not about the neighbor - their own agent reads it perfectly
    // well. Collapsing that to `false` is the failure the whole warning exists
    // to avoid: the operator is told nobody shares their payout address, on
    // the strength of a directory we never looked in.
    if (process.getuid?.() === 0) {
      return; // root ignores the mode bits
    }
    const own = makeAgent(projectRoot, 'starter');
    const neighbor = makeAgent(homeRoot, 'sealed', { paid: true });
    const skillsDir = join(neighbor, 'skills');
    chmodSync(skillsDir, 0o000);

    try {
      const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

      expect(found.map((entry) => [entry.name, entry.paid])).toEqual([['sealed', 'unknown']]);
    } finally {
      chmodSync(skillsDir, 0o700);
    }
  });

  it("says 'unknown' when the loader silently dropped a skill it could read", async () => {
    // The other half of the denominator, and the one `sawLess` cannot see: the
    // file reads fine, `loadSkillsFromDir` refuses it (a frontmatter it will not
    // validate), and the loader reports that by returning FEWER skills rather
    // than by throwing. Without the count comparison the neighbor comes back
    // with no paid skills and no warning at all.
    const own = makeAgent(projectRoot, 'starter');
    const neighbor = makeAgent(homeRoot, 'loader-refuses', { paid: false });
    const broken = join(neighbor, 'skills', 'malformed');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'SKILL.md'), '---\nname: 💥 not a name\n---\n\nBody.\n', 'utf-8');

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => [entry.name, entry.paid])).toEqual([['loader-refuses', 'unknown']]);
  });

  it('does not warn about a neighbor that simply has no skills directory', async () => {
    // ENOENT is the one absolute answer: there is no directory, so there are no
    // paid skills, and saying `unknown` about it would warn on every agent that
    // has not added a skill yet. Everything else - EACCES, ENOTDIR - may be a
    // fact about OUR process rather than about the agent.
    const own = makeAgent(projectRoot, 'starter');
    makeAgent(homeRoot, 'no-skills-dir', { skills: false });

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found).toEqual([]);
  });

  it('does not let a stray file tip a neighbor into unknown', async () => {
    // The denominator is subdirectories whose SKILL.md reads - not `readdir`
    // entries - or a single `.DS_Store` would make every neighbor unknown
    // forever.
    const own = makeAgent(projectRoot, 'starter');
    const neighbor = makeAgent(homeRoot, 'tidy', { paid: false });
    writeFileSync(join(neighbor, 'skills', '.DS_Store'), 'junk', 'utf-8');
    mkdirSync(join(neighbor, 'skills', 'empty'), { recursive: true });

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found).toEqual([]);
  });
});

describe("a neighbor's SKILL.md that is not a regular file", () => {
  it("says 'unknown' for the whole neighbor, without reading it", async () => {
    // A synchronous read of a FIFO does not fail - it takes the event loop with
    // it, and no `catch` ever runs. The gate therefore short-circuits the whole
    // neighbor rather than treating this as one more signal in the
    // denominator.
    //
    // The WRITER is mandatory: without one the mutant does not go red, it
    // hangs, and a hung run is not a killed mutant. With one it reads a
    // perfectly valid PAID skill and answers `true` where the fixed code
    // answers `unknown` - the two differ by a verdict.
    const own = makeAgent(projectRoot, 'starter');
    // A PAID ordinary skill beside the FIFO, and that is what makes the fixture
    // measure anything. With a free one the verdict is `unknown` either way:
    // without this gate the SDK loader's own gate drops the piped skill, the
    // count comes up short, and `skills.length < denominator` answers `unknown`
    // for a different reason. Paid, the short-circuit above the denominator
    // fires first and the mutant answers `true` - measured, both directions.
    const neighbor = makeAgent(homeRoot, 'piped');
    const skillDir = join(neighbor, 'skills', 'fifo-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, 'SKILL.md');
    execFileSync('mkfifo', [skillMd]);
    startWriter(
      skillMd,
      '---\nname: piped\ndescription: a skill delivered through a pipe\ncapabilities: [text-gen]\nprice: 1000000\n---\n\nBody.\n',
    );

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => [entry.name, entry.paid])).toEqual([['piped', 'unknown']]);
  });
});

describe('what a neighbor directory is allowed to be called', () => {
  it('drops a name the schema refuses, leaving only the anchor', async () => {
    // Checked RAW. Sanitizing first would turn `ali\x01ce` into `alice` and
    // print it as a legitimate neighbor's name.
    const own = makeAgent(projectRoot, 'starter');
    makeAgent(homeRoot, 'anchor');
    makeAgent(homeRoot, 'alice');

    const found = await findSharedPayoutNeighbors(work, own, 'devnet', ADDRESS);

    expect(found.map((entry) => entry.name)).toEqual(['anchor']);
  });

  it('keeps a newline in a path from breaking the banner across lines', async () => {
    // A newline is legal in a POSIX path and the sanitizer deliberately keeps
    // it - it is one of the two characters it does not delete. Left in the
    // printed path it splits the warning into two lines, and the second one can
    // be made to read like a line the agent itself printed.
    const oddWork = join(sandbox, 'wo\nrk');
    const oddProjectRoot = join(oddWork, '.elisym');
    mkdirSync(oddProjectRoot, { recursive: true });
    const own = makeAgent(oddProjectRoot, 'starter');
    makeAgent(oddProjectRoot, 'neighbor');

    const found = await findSharedPayoutNeighbors(oddWork, own, 'devnet', ADDRESS);

    expect(found).toHaveLength(1);
    expect(found[0]?.dir).not.toContain('\n');
    expect(found[0]?.dir).toBe(join(sandbox, 'wo rk', '.elisym', 'neighbor'));
  });

  it('strips a control character out of the printed PATH', async () => {
    // The byte has to sit in a path component the neighbor's `dir` actually
    // CARRIES - an operator's project root - not one level deeper inside the
    // `.elisym` root. A directory there is a candidate in its own right, has no
    // `elisym.yaml`, and is dropped by the listing before any name check runs:
    // the earlier version of this fixture found nothing at all and asserted
    // over an empty list.
    const weirdWork = join(sandbox, 'wo\u0001rk');
    const weirdProjectRoot = join(weirdWork, '.elisym');
    mkdirSync(weirdProjectRoot, { recursive: true });
    const own = makeAgent(weirdProjectRoot, 'starter');
    makeAgent(weirdProjectRoot, 'neighbor');

    const found = await findSharedPayoutNeighbors(weirdWork, own, 'devnet', ADDRESS);

    expect(found).toHaveLength(1);
    expect(found[0]?.dir).not.toContain('\u0001');
    // And the path is still the one the operator has on disk, minus the byte -
    // not a dereferenced `/private/var/...` they would not recognize. Compared
    // whole: `toContain('neighbor')` would pass on the dereferenced path too.
    expect(found[0]?.dir).toBe(deleteControlCharacters(join(weirdProjectRoot, 'neighbor')));
  });
});
