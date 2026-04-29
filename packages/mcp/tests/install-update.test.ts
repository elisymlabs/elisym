/**
 * Tests for `runUpdate` in install.ts.
 *
 * `runUpdate` walks each known MCP client config, refreshes the version pin,
 * and preserves any existing `ELISYM_AGENT` binding + env vars. We test it
 * against a real cursor config under a tmpdir HOME so we exercise the actual
 * read/parse/write path without mocking node:fs.
 *
 * Cursor's path is `~/.cursor/mcp.json` on every platform, so it's the easiest
 * client to point at a fake home. We also pass `client: 'cursor'` to keep the
 * blast radius narrow on dev machines that may have a real claude-desktop
 * config.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInstall, runUpdate, safeRewriteJson } from '../src/install.js';
import { PACKAGE_VERSION } from '../src/utils.js';

describe('runUpdate', () => {
  let dir: string;
  let originalHome: string | undefined;
  let cursorPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-update-'));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    cursorPath = join(dir, '.cursor', 'mcp.json');
    await mkdir(join(dir, '.cursor'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('refreshes the version pin and preserves the existing agent binding', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'alice', ELISYM_PASSPHRASE: 'secret' },
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), {
      mode: 0o600,
    });

    await runUpdate({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    const entry = after.mcpServers.elisym;
    expect(entry.args).toEqual(['-y', `@elisym/mcp@~${PACKAGE_VERSION}`]);
    // Existing agent + env must survive an update.
    expect(entry.env.ELISYM_AGENT).toBe('alice');
    expect(entry.env.ELISYM_PASSPHRASE).toBe('secret');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Updated cursor'));
  });

  it('overrides the agent binding when --agent is supplied', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'alice' },
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), {
      mode: 0o600,
    });

    await runUpdate({ client: 'cursor', agent: 'bob' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(after.mcpServers.elisym.env.ELISYM_AGENT).toBe('bob');
  });

  it('silently skips clients whose config does not exist (ENOENT)', async () => {
    // No file written - cursor config does not exist.
    await runUpdate({ client: 'cursor' });

    // Should not crash, should not create the file, and the only log should be
    // the "no installs" summary - never a per-client warning.
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Skipped'))).toBe(false);
    expect(calls.some((s) => s.includes('Warning'))).toBe(false);
    expect(calls).toContain('No existing elisym MCP installs found to update.');
  });

  it('warns and skips when the config file is not valid JSON, leaving it untouched', async () => {
    const garbage = '{not valid json at all';
    await writeFile(cursorPath, garbage, { mode: 0o600 });

    await runUpdate({ client: 'cursor' });

    // The file must not have been rewritten.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(garbage);
    // The user must see a warning naming the file.
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Warning') && s.includes(cursorPath))).toBe(true);
  });

  it('skips configs that exist but do not have an elisym entry', async () => {
    const before = { mcpServers: { other: { command: 'foo' } } };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), {
      mode: 0o600,
    });

    await runUpdate({ client: 'cursor' });

    // File must be untouched - we did not insert an empty elisym entry.
    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(after.mcpServers.elisym).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: 'foo' });
  });

  // Regression: an existing entry with no `env` at all must round-trip without
  // the spread crashing or producing weird {env: {0: ...}} from a non-object.
  it('handles existing elisym entries that have no env block', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), {
      mode: 0o600,
    });

    await runUpdate({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    const entry = after.mcpServers.elisym;
    expect(entry.args).toEqual(['-y', `@elisym/mcp@~${PACKAGE_VERSION}`]);
    // No agent was bound before; nothing should appear after.
    expect(entry.env).toBeUndefined();
  });

  // If a hand-edited config holds an invalid ELISYM_AGENT, runUpdate must NOT
  // bake that invalid name into a fresh entry. The file must be left untouched
  // and a Skipped warning must be logged so the user can fix it explicitly.
  it('refuses to update when the existing ELISYM_AGENT is invalid', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'bad name with spaces', ELISYM_PASSPHRASE: 'x' },
        },
      },
    };
    const original = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, original, { mode: 0o600 });

    await runUpdate({ client: 'cursor' });

    // File must be byte-for-byte unchanged.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(original);

    // User must see a "Skipped" warning naming the file.
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Skipped cursor') && s.includes(cursorPath))).toBe(true);
  });

  // --agent validation must happen before any I/O. A bad name should reject
  // the whole call without touching even one config.
  it('rejects an invalid --agent before reading any config', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'alice' },
        },
      },
    };
    const original = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, original, { mode: 0o600 });

    await expect(runUpdate({ client: 'cursor', agent: 'my agent' })).rejects.toThrow();

    // File must not have been touched by the failed call.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(original);
  });

  // Guard regression: a malformed config where mcpServers.elisym is a primitive
  // (e.g. a string from a botched merge) must be skipped, not crash on `.env`.
  it('skips malformed entries where mcpServers.elisym is not an object', async () => {
    const before = { mcpServers: { elisym: 'oops-this-should-be-an-object' } };
    const original = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, original, { mode: 0o600 });

    await expect(runUpdate({ client: 'cursor' })).resolves.not.toThrow();

    // File must be untouched - we never overwrite malformed user data.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(original);
  });

  // Typos in --client used to silently match no client and print "no installs
  // found", which made the user think the operation succeeded. The validator
  // now rejects unknown values up-front, before any I/O.
  it('rejects an unknown --client value before touching any config', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'alice' },
        },
      },
    };
    const original = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, original, { mode: 0o600 });

    await expect(runUpdate({ client: 'claud-code' /* typo */ })).rejects.toThrow(/Unknown client/);

    // File must be untouched - validation must fail before any read/write.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(original);
  });

  // ~/.claude.json is much richer than cursor's mcp.json: top-level keys like
  // userID/projects/firstStartTime must round-trip untouched, and sibling MCP
  // servers must not be disturbed. This is the shape that runUpdate was most
  // likely to corrupt and the cursor-only tests above didn't cover it.
  it('preserves unrelated top-level keys when updating claude-code config', async () => {
    const claudeCodePath = join(dir, '.claude.json');
    const before = {
      userID: 'abc123',
      firstStartTime: '2025-01-01T00:00:00Z',
      projects: {
        '/Users/foo/repo': { mcpServers: { local: { command: 'foo' } }, history: ['cmd1'] },
      },
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          env: { ELISYM_AGENT: 'alice', ELISYM_PASSPHRASE: 'secret' },
        },
        'other-server': { command: 'bar', args: ['--baz'] },
      },
    };
    await writeFile(claudeCodePath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runUpdate({ client: 'claude-code' });

    const after = JSON.parse(await readFile(claudeCodePath, 'utf-8'));
    // Top-level keys outside mcpServers must be byte-equivalent.
    expect(after.userID).toBe('abc123');
    expect(after.firstStartTime).toBe('2025-01-01T00:00:00Z');
    expect(after.projects).toEqual(before.projects);
    // Sibling MCP servers must be untouched.
    expect(after.mcpServers['other-server']).toEqual({ command: 'bar', args: ['--baz'] });
    // elisym entry refreshed; agent + env preserved.
    expect(after.mcpServers.elisym.args).toEqual(['-y', `@elisym/mcp@~${PACKAGE_VERSION}`]);
    expect(after.mcpServers.elisym.env.ELISYM_AGENT).toBe('alice');
    expect(after.mcpServers.elisym.env.ELISYM_PASSPHRASE).toBe('secret');
  });

  // Regression: an `update` must NOT pull the entry through buildServerEntry,
  // because that drops any custom fields the user added (cwd, fully-qualified
  // `command` path, extra flags in `args` around the package spec). The fix
  // mutates `existing` in place and only touches the `@elisym/mcp@...` token
  // inside `args` plus the `env` block.
  it('preserves custom fields (cwd, command, sibling args) across update', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: '/usr/local/bin/npx',
          args: ['-y', '--registry', 'https://my.registry/', '@elisym/mcp@~0.0.1', '--verbose'],
          env: { ELISYM_AGENT: 'alice' },
          cwd: '/tmp/elisym-workdir',
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runUpdate({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    const entry = after.mcpServers.elisym;
    // Custom command path must survive.
    expect(entry.command).toBe('/usr/local/bin/npx');
    // cwd must survive.
    expect(entry.cwd).toBe('/tmp/elisym-workdir');
    // The package spec must be refreshed at its original index, sibling args untouched.
    expect(entry.args).toEqual([
      '-y',
      '--registry',
      'https://my.registry/',
      `@elisym/mcp@~${PACKAGE_VERSION}`,
      '--verbose',
    ]);
    // Env preserved.
    expect(entry.env.ELISYM_AGENT).toBe('alice');
  });

  // Existing key order in `env` must be preserved across an update so user
  // dotfiles don't get noisy reorder diffs. The previous implementation went
  // through buildServerEntry which delete-then-readd ELISYM_AGENT, moving it
  // to the end of the env block.
  it('preserves the existing env key order across update', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', '@elisym/mcp@~0.0.1'],
          // ELISYM_AGENT in the MIDDLE of the env block — must stay there.
          env: {
            FOO_FIRST: '1',
            ELISYM_AGENT: 'alice',
            ELISYM_PASSPHRASE: 'secret',
            ZED_LAST: 'z',
          },
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runUpdate({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    // Object.keys reflects insertion order in V8 — same order as the source.
    expect(Object.keys(after.mcpServers.elisym.env)).toEqual([
      'FOO_FIRST',
      'ELISYM_AGENT',
      'ELISYM_PASSPHRASE',
      'ZED_LAST',
    ]);
  });
});

describe('runInstall', () => {
  let dir: string;
  let originalHome: string | undefined;
  let cursorPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-install-'));
    originalHome = process.env.HOME;
    process.env.HOME = dir;
    cursorPath = join(dir, '.cursor', 'mcp.json');
    await mkdir(join(dir, '.cursor'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  // Regression: previous installToConfig replaced a malformed JSON file with
  // `{mcpServers: {elisym: ...}}`, destroying every other top-level key. For
  // ~/.claude.json that meant losing userID/projects/firstStartTime/history on
  // a single typo. The fix is to throw and let the user fix the JSON manually.
  it('refuses to overwrite a malformed JSON config; file is left untouched', async () => {
    const garbage = '{not valid json at all';
    await writeFile(cursorPath, garbage, { mode: 0o600 });

    await runInstall({ client: 'cursor' });

    // File must be byte-for-byte unchanged.
    const after = await readFile(cursorPath, 'utf-8');
    expect(after).toBe(garbage);

    // The user must see a Skipped log naming the file with a "not valid JSON" message.
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Skipped cursor') && s.includes('not valid JSON'))).toBe(
      true,
    );
    // Must NOT print the misleading "may have been lost" warning the old code emitted.
    expect(calls.some((s) => s.includes('may have been lost'))).toBe(false);
  });

  // Happy path: ENOENT → fresh file is created with our entry.
  it('creates a fresh config when none exists', async () => {
    // No file written.
    await runInstall({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(after.mcpServers.elisym.args).toEqual(['-y', `@elisym/mcp@~${PACKAGE_VERSION}`]);
  });

  // Adding into an existing config must preserve sibling MCP servers and other
  // top-level keys (the rich-claude-json shape).
  it('adds elisym alongside other mcp servers without disturbing siblings', async () => {
    const before = {
      userID: 'abc',
      mcpServers: {
        'other-server': { command: 'foo', args: ['--bar'] },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runInstall({ client: 'cursor' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(after.userID).toBe('abc');
    expect(after.mcpServers['other-server']).toEqual({ command: 'foo', args: ['--bar'] });
    expect(after.mcpServers.elisym.args).toEqual(['-y', `@elisym/mcp@~${PACKAGE_VERSION}`]);
  });

  it('rebinds an existing entry to a new agent when --agent is supplied', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`],
          env: { ELISYM_AGENT: 'alice', ELISYM_PASSPHRASE: 'secret' },
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runInstall({ client: 'cursor', agent: 'bob' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    const entry = after.mcpServers.elisym;
    expect(entry.env.ELISYM_AGENT).toBe('bob');
    // Sibling env keys must survive the rebind.
    expect(entry.env.ELISYM_PASSPHRASE).toBe('secret');
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Rebound cursor') && s.includes('"bob"'))).toBe(true);
  });

  it('sets ELISYM_AGENT on an existing entry that had no env block', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`],
        },
      },
    };
    await writeFile(cursorPath, JSON.stringify(before, null, 2), { mode: 0o600 });

    await runInstall({ client: 'cursor', agent: 'carol' });

    const after = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(after.mcpServers.elisym.env).toEqual({ ELISYM_AGENT: 'carol' });
  });

  it('is a no-op when --agent matches the already-stored ELISYM_AGENT', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`],
          env: { ELISYM_AGENT: 'alice' },
        },
      },
    };
    const beforeRaw = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, beforeRaw, { mode: 0o600 });

    await runInstall({ client: 'cursor', agent: 'alice' });

    const afterRaw = await readFile(cursorPath, 'utf-8');
    expect(afterRaw).toBe(beforeRaw);
    const calls = logSpy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('Already installed in cursor'))).toBe(true);
  });

  it('leaves existing entries untouched when --agent is not supplied', async () => {
    const before = {
      mcpServers: {
        elisym: {
          command: 'npx',
          args: ['-y', `@elisym/mcp@~${PACKAGE_VERSION}`],
          env: { ELISYM_AGENT: 'alice' },
        },
      },
    };
    const beforeRaw = JSON.stringify(before, null, 2);
    await writeFile(cursorPath, beforeRaw, { mode: 0o600 });

    await runInstall({ client: 'cursor' });

    const afterRaw = await readFile(cursorPath, 'utf-8');
    expect(afterRaw).toBe(beforeRaw);
  });
});

describe('safeRewriteJson', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-saferewrite-'));
    path = join(dir, 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Happy path: bytes on disk match what the caller passed in → write succeeds.
  it('writes the new config when on-disk content matches expectedRaw', async () => {
    const initial = JSON.stringify({ a: 1 }, null, 2);
    await writeFile(path, initial, { mode: 0o600 });

    await safeRewriteJson(path, initial, { a: 2 });

    const after = JSON.parse(await readFile(path, 'utf-8'));
    expect(after).toEqual({ a: 2 });
  });

  // RMW guard: caller's expectedRaw doesn't match the file → throw and do NOT
  // write. This simulates the case where another process modified the file
  // between our read and our write.
  it('aborts and leaves the file untouched when expectedRaw is stale', async () => {
    const onDisk = JSON.stringify({ current: 'state' }, null, 2);
    await writeFile(path, onDisk, { mode: 0o600 });

    const stale = JSON.stringify({ outdated: 'snapshot' }, null, 2);

    await expect(safeRewriteJson(path, stale, { newConfig: true })).rejects.toThrow(
      /modified by another process/,
    );

    // File must still hold the on-disk state, NOT our discarded new config.
    const after = await readFile(path, 'utf-8');
    expect(after).toBe(onDisk);
  });

  // Edge case: file disappeared entirely between read and write. Distinct error
  // message so the user can tell apart "raced with another writer" from
  // "raced with rm/restart".
  it('throws a distinct error when the file disappeared between read and write', async () => {
    await expect(safeRewriteJson(path, '{"never":"existed"}', { x: 1 })).rejects.toThrow(
      /disappeared/,
    );
  });
});
