import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as askr from '@elisym/askr';
import { Command } from 'commander';
import { nip19 } from 'nostr-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptSnippet } from '../src/commands/askr/embed';
import { keyFileOf } from '../src/commands/askr/owner-key';
import { registerAskr } from '../src/commands/askr/register';
import { type RunnerIo, emit, emitParseError, runAskrCommand } from '../src/commands/askr/runner';
import {
  INIT_ARGS,
  ORIGIN,
  cleanupHomes,
  drive,
  harness,
  initInvocation,
  tempDir,
} from './askr-fake';

const HERE = dirname(fileURLToPath(import.meta.url));

// Each case runs whole commands (key files, signing, many calls): slower than a unit under a loaded `bun qa`.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupHomes();
});

function recordingIo(): RunnerIo & { lines: string[]; exits: number[]; order: string[] } {
  const lines: string[] = [];
  const exits: number[] = [];
  const order: string[] = [];
  return {
    lines,
    exits,
    order,
    write: (line, flushed) => {
      lines.push(line);
      order.push('write');
      setImmediate(() => {
        order.push('flushed');
        flushed();
      });
    },
    exit: (code) => {
      order.push('exit');
      exits.push(code);
    },
  };
}

async function parse(argv: string[]): Promise<{ io: ReturnType<typeof recordingIo>; ran: number }> {
  const program = new Command().name('elisym');
  const io = recordingIo();
  let ran = 0;
  registerAskr(
    program,
    async () => {
      ran += 1;
    },
    argv.slice(1),
    true,
  );
  try {
    await program.parseAsync(['node', 'elisym', ...argv]);
  } catch (error) {
    emitParseError(error, io);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { io, ran };
}

describe('askr plan parsing', () => {
  it('passes --yearly to a paid plan, and nothing without it', async () => {
    const seen: unknown[] = [];
    for (const argv of [
      ['askr', 'plan', 'pro', '--yearly'],
      ['askr', 'plan', 'growth'],
    ]) {
      const program = new Command().name('elisym');
      registerAskr(
        program,
        async (invocation) => {
          seen.push(invocation);
        },
        argv.slice(1),
        true,
      );
      await program.parseAsync(['node', 'elisym', ...argv]);
    }
    expect(seen).toEqual([
      { command: 'plan', plan: 'pro', options: { yearly: true } },
      { command: 'plan', plan: 'growth', options: {} },
    ]);
  });
});

describe('the askr output contract', () => {
  it('an unknown flag and a missing value are one JSON object, exit 1, nothing on stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const argv of [
      ['askr', 'status', '--bogus'],
      ['askr', 'products'],
      ['askr', 'init', '--name'],
      ['askr', 'nope'],
    ]) {
      const { io, ran } = await parse(argv);
      expect(ran).toBe(0);
      expect(io.lines).toHaveLength(1);
      const output = JSON.parse(io.lines[0] ?? '');
      expect(output).toMatchObject({ ok: false, error: { code: 'bad_flag' } });
      expect(io.exits).toEqual([1]);
    }
    expect(stderr).not.toHaveBeenCalled();
  });

  it('askr --help prints help, exits 0, never loads @elisym/askr', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const loadAskr = vi.fn(async () => askr);
    const program = new Command().name('elisym');
    registerAskr(
      program,
      async (invocation, context) => {
        await runAskrCommand(invocation, context, {
          loadAskr,
          deps: () => {
            throw new Error('not reached');
          },
          io: recordingIo(),
          hasWebSocket: () => true,
        });
      },
      ['--help'],
      true,
    );
    const io = recordingIo();
    try {
      await program.parseAsync(['node', 'elisym', 'askr', '--help']);
    } catch (error) {
      emitParseError(error, io);
    }
    expect(io.exits).toEqual([0]);
    expect(io.lines).toHaveLength(0);
    const help = stdout.mock.calls.map((call) => String(call[0])).join('');
    for (const command of [
      'init',
      'plan',
      'products',
      'policy',
      'connector',
      'status',
      'embed',
      'export-key',
    ]) {
      expect(help).toContain(command);
    }
    expect(loadAskr).not.toHaveBeenCalled();
  });

  it('askr help and askr help <command> print help and exit 0, with no JSON error', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const argv of [
      ['askr', 'help'],
      ['askr', 'help', 'init'],
    ]) {
      stdout.mockClear();
      const { io, ran } = await parse(argv);
      expect(ran).toBe(0);
      expect(io.lines).toEqual([]);
      expect(io.exits).toEqual([0]);
      expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('Usage:');
    }
  });

  it('exits exactly once, only after the JSON line was flushed', async () => {
    const io = recordingIo();
    emit({ exitCode: 4, output: { ok: false } }, io);
    expect(io.exits).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(io.order).toEqual(['write', 'flushed', 'exit']);
    expect(io.exits).toEqual([4]);
  });

  it('a thrown error is one JSON object without its text; a missing package is askr_unavailable', async () => {
    const io = recordingIo();
    const secretText = 'a'.repeat(64);
    await drive(
      runAskrCommand(
        { command: 'status', options: {} },
        { args: ['status'] },
        {
          loadAskr: async () => askr,
          deps: () => {
            throw new Error(`boom ${secretText}`);
          },
          io,
          hasWebSocket: () => true,
        },
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(io.lines.join('')).not.toContain(secretText);
    expect(JSON.parse(io.lines[0] ?? '')).toMatchObject({ error: { code: 'unexpected' } });
    expect(io.exits).toEqual([1]);

    const missing = recordingIo();
    await drive(
      runAskrCommand(
        { command: 'status', options: {} },
        { args: ['status'] },
        {
          loadAskr: async () => {
            throw new Error('Cannot find package');
          },
          deps: () => {
            throw new Error('not reached');
          },
          io: missing,
          hasWebSocket: () => true,
        },
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.parse(missing.lines[0] ?? '')).toMatchObject({
      error: { code: 'askr_unavailable' },
    });
    expect(missing.exits).toEqual([1]);
  });

  it('no global WebSocket: node_version, exit 1', async () => {
    const io = recordingIo();
    const outcome = await drive(
      runAskrCommand(
        { command: 'status', options: {} },
        { args: ['status'] },
        {
          loadAskr: async () => askr,
          deps: () => {
            throw new Error('not reached');
          },
          io,
          hasWebSocket: () => false,
        },
      ),
    );
    expect(outcome).toMatchObject({ exitCode: 1, output: { error: { code: 'node_version' } } });
  });

  it('base overrides: a non-local host is refused without the unsafe flag; the base in use is announced on stderr', async () => {
    const setup = await harness();
    setup.deps.env = { ELISYM_ASKR_API: 'https://elsewhere.example' };
    const refused = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(refused).toMatchObject({ exitCode: 1, output: { error: { code: 'bad_override' } } });
    setup.deps.env = { ELISYM_ASKR_API: 'https://elsewhere.example', ELISYM_ASKR_UNSAFE_TEST: '1' };
    const allowed = await setup.run({ command: 'status', options: {} }, ['status']);
    expect(allowed.exitCode).toBe(0);
    expect(setup.stderr.join('\n')).toContain(
      'ELISYM_ASKR_API override in use: https://elsewhere.example',
    );
  });

  it('every exit 4 resume carries --profile when one is used', async () => {
    const setup = await harness();
    setup.fake.holdPublication = true;
    await setup.run(initInvocation(), [...INIT_ARGS, '--profile', 'shop2'], 'shop2');
    const outcome = await setup.run(
      { command: 'plan', plan: 'free' },
      ['plan', 'free', '--profile', 'shop2'],
      'shop2',
    );
    expect(outcome.output.resume).toBe('npx -y @elisym/cli@latest askr plan free --profile shop2');
  });
});

describe('loading', () => {
  it('the built CLI has no top-level @elisym/askr or @elisym/commerce import, only the dynamic one', async () => {
    const bundle = await readFile(join(HERE, '..', 'dist', 'index.js'), 'utf-8');
    expect(bundle).not.toMatch(/^\s*import[^;]*from\s*['"]@elisym\/(askr|commerce)['"]/m);
    expect(bundle).not.toMatch(/^\s*import\s*['"]@elisym\/(askr|commerce)['"]/m);
    expect(bundle).toMatch(/import\(\s*['"]@elisym\/askr['"]\s*\)/);
  });
});

describe('askr embed and export-key', () => {
  it('the snippet equals the form in the embed docs', async () => {
    const page = await readFile(
      join(HERE, '..', '..', 'docs', 'pages', 'askr', 'embed.mdx'),
      'utf-8',
    );
    const documented = /```html\n(<script [^\n]*><\/script>)\n```/.exec(page)?.[1];
    expect(documented).toBe(scriptSnippet('npub1...'));
  });

  it('embed prints the snippet, meta tag, CSP and the add-to-cart hook for an admin source', async () => {
    const setup = await harness();
    const init = await setup.run(initInvocation(), INIT_ARGS);
    const outcome = await setup.run({ command: 'embed' }, ['embed']);
    const storeId = String(init.output.storeId);
    expect(outcome.output).toMatchObject({
      ok: true,
      snippet: scriptSnippet(storeId),
      verificationMeta: `<meta name="askr-verification" content="${storeId}">`,
    });
    expect(String(outcome.output.addToCart)).toContain('onAddToCart');
  });

  it('export-key writes 0600, never overwrites', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const out = join(await tempDir(), 'askr-key.txt');
    const written = await setup.run({ command: 'export-key', out }, ['export-key']);
    expect(written.output).toEqual({ ok: true, path: out });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const key = JSON.parse(await readFile(keyFileOf(setup.home, 'default'), 'utf-8'));
    const nsec = nip19.nsecEncode(Uint8Array.from(Buffer.from(key.secretKey, 'hex')));
    expect(await readFile(out, 'utf-8')).toContain(`Secret key: ${nsec}`);
    await writeFile(out, 'mine');
    const again = await setup.run({ command: 'export-key', out }, ['export-key']);
    expect(again).toMatchObject({ exitCode: 1, output: { error: { code: 'file_exists' } } });
    expect(await readFile(out, 'utf-8')).toBe('mine');
  });
});

describe('no secret in any output', () => {
  it('every command prints neither the owner key in hex nor as an nsec', async () => {
    const setup = await harness();
    await setup.run(
      initInvocation({ source: 'connector', platform: 'shopify', shopUrl: ORIGIN }),
      INIT_ARGS,
    );
    await setup.run({ command: 'plan', plan: 'free' }, ['plan', 'free']);
    setup.fake.runResult = {
      status: 'ok',
      diff: { created: [], updated: [], hidden: [], unchanged: [] },
    };
    const dir = await tempDir();
    const policy = join(dir, 'faq.md');
    await writeFile(policy, 'Questions.');
    const products = join(dir, 'p.json');
    await writeFile(products, '[]');
    await setup.run({ command: 'connector' }, ['connector']);
    await setup.run({ command: 'policy', options: { slug: 'faq', title: 'FAQ', file: policy } }, [
      'policy',
    ]);
    await setup.run({ command: 'products', options: { file: products } }, ['products']);
    await setup.run({ command: 'status', options: { probe: true } }, ['status']);
    await setup.run({ command: 'embed' }, ['embed']);
    await setup.run({ command: 'export-key', out: join(dir, 'k.txt') }, ['export-key']);
    await setup.run(initInvocation({ name: 'Changed' }), ['init']);
    await setup.run({ command: 'plan', plan: 'pro' }, ['plan', 'pro']);
    const key = JSON.parse(await readFile(keyFileOf(setup.home, 'default'), 'utf-8'));
    const hex = String(key.secretKey);
    const nsec = nip19.nsecEncode(Uint8Array.from(Buffer.from(hex, 'hex')));
    const printed = [...setup.stdout, ...setup.stderr].join('\n');
    expect(setup.stdout.length).toBeGreaterThanOrEqual(10);
    expect(printed.toLowerCase()).not.toContain(hex.toLowerCase());
    expect(printed).not.toContain(nsec);
  });
});
