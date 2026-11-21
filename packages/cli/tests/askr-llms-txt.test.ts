import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as admin from '../../askr-admin/src/lib/llms-txt';
import {
  siteLlmsTxt,
  siteLlmsTxtSection,
  storeCatalogJsonUrl,
  storeLlmsTxtUrl,
  writeSiteLlmsTxt,
  MAX_EXISTING_LLMS_BYTES,
} from '../src/commands/askr/llms-txt';
import { registerAskr } from '../src/commands/askr/register';
import type { AskrInvocation } from '../src/commands/askr/runner';
import { INIT_ARGS, cleanupHomes, harness, initInvocation, tempDir } from './askr-fake';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupHomes();
});

const NPUB = 'npub1julcj7ptw2nk3xtfwkq78gftq3tj92f2phunjf9acg47fcgpr7aq0vpnpz';

describe("the site's llms.txt", () => {
  it('is the form the docs page shows', async () => {
    const page = await readFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'docs',
        'pages',
        'askr',
        'ai-agents.mdx',
      ),
      'utf-8',
    );
    const documented = /```markdown\n([\s\S]*?)```/.exec(page)?.[1];
    expect(documented).toBe(siteLlmsTxt('npub1...', 'Your store'));
  });

  it('is the admin text, word for word', () => {
    for (const name of ['Example Shop', '## Tea\n\nHouse', '', '  Café  ']) {
      expect(siteLlmsTxt(NPUB, name)).toBe(admin.siteLlmsTxt(NPUB, name));
    }
    expect(siteLlmsTxtSection(NPUB)).toBe(admin.siteLlmsTxtSection(NPUB));
    expect(storeLlmsTxtUrl(NPUB)).toBe(admin.storeLlmsTxtUrl(NPUB));
    expect(storeCatalogJsonUrl(NPUB)).toBe(admin.storeCatalogJsonUrl(NPUB));
    expect(storeLlmsTxtUrl(NPUB)).toBe(`https://app.askr.elisym.network/s/${NPUB}/llms.txt`);
  });

  it('askr embed takes --llms-txt <path>', async () => {
    const seen: AskrInvocation[] = [];
    for (const argv of [
      ['askr', 'embed'],
      ['askr', 'embed', '--llms-txt', 'public/llms.txt'],
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
    expect(seen).toStrictEqual([
      { command: 'embed', options: {} },
      { command: 'embed', options: { llmsTxt: 'public/llms.txt' } },
    ]);
  });

  it('askr embed prints it with the Store ID and its public URL', async () => {
    const setup = await harness();
    const init = await setup.run(initInvocation(), INIT_ARGS);
    const storeId = String(init.output.storeId);
    const outcome = await setup.run({ command: 'embed' }, ['embed']);
    expect(outcome.output).toMatchObject({
      ok: true,
      llmsTxt: siteLlmsTxt(storeId, 'Example Shop'),
      llmsTxtUrl: `https://app.askr.elisym.network/s/${storeId}/llms.txt`,
    });
    expect(outcome.output).not.toHaveProperty('llmsTxtFile');
  });

  it('askr embed --llms-txt writes a new file, appends to an existing one once, and leaves it after', async () => {
    const setup = await harness();
    const init = await setup.run(initInvocation(), INIT_ARGS);
    const storeId = String(init.output.storeId);
    const dir = await tempDir();
    const fresh = join(dir, 'llms.txt');
    const created = await setup.run({ command: 'embed', options: { llmsTxt: fresh } }, ['embed']);
    expect(created.output).toMatchObject({ llmsTxtFile: { path: fresh, result: 'created' } });
    expect(await readFile(fresh, 'utf-8')).toBe(siteLlmsTxt(storeId, 'Example Shop'));

    const site = join(dir, 'site');
    await mkdir(site);
    const own = join(site, 'llms.txt');
    await writeFile(own, '# My site\n\n> About us.');
    const appended = await setup.run({ command: 'embed', options: { llmsTxt: own } }, ['embed']);
    expect(appended.output).toMatchObject({ llmsTxtFile: { result: 'appended' } });
    expect(await readFile(own, 'utf-8')).toBe(
      `# My site\n\n> About us.\n\n${siteLlmsTxtSection(storeId)}`,
    );
    const again = await setup.run({ command: 'embed', options: { llmsTxt: own } }, ['embed']);
    expect(again.output).toMatchObject({ llmsTxtFile: { result: 'unchanged' } });
    expect(await readFile(own, 'utf-8')).toBe(
      `# My site\n\n> About us.\n\n${siteLlmsTxtSection(storeId)}`,
    );
  });

  it('askr embed --llms-txt writes only a regular file named llms.txt', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    const dir = await tempDir();
    const other = join(dir, 'notes.md');
    await writeFile(other, 'mine');
    const named = await setup.run({ command: 'embed', options: { llmsTxt: other } }, ['embed']);
    expect(named).toMatchObject({ exitCode: 1, output: { error: { code: 'file_not_writable' } } });
    expect(await readFile(other, 'utf-8')).toBe('mine');

    const linkDir = join(dir, 'linked');
    await mkdir(linkDir);
    const link = join(linkDir, 'llms.txt');
    await symlink(other, link);
    const linked = await setup.run({ command: 'embed', options: { llmsTxt: link } }, ['embed']);
    expect(linked).toMatchObject({ exitCode: 1, output: { error: { code: 'file_not_writable' } } });
    expect(await readFile(other, 'utf-8')).toBe('mine');

    const missingDir = join(dir, 'nowhere', 'llms.txt');
    const missing = await setup.run({ command: 'embed', options: { llmsTxt: missingDir } }, [
      'embed',
    ]);
    expect(missing).toMatchObject({
      exitCode: 1,
      output: { error: { code: 'file_not_writable' } },
    });
  });
});

const OTHER_NPUB = 'npub15qsf69hua5f46qayxh952gy2kjmyy8pkf40xqzxctt45j9hhkh4s8uw5x4';

async function refusal(path: string): Promise<unknown> {
  try {
    await writeSiteLlmsTxt(path, NPUB, 'Shop');
  } catch (error) {
    return error;
  }
  throw new Error('not refused');
}

describe('writing the site llms.txt', () => {
  it('writes only a file named exactly llms.txt', async () => {
    const dir = await tempDir();
    for (const name of ['foo-llms.txt', 'llms.txt.bak', 'LLMS.TXT', 'llms.md']) {
      expect(await refusal(join(dir, name)), name).toMatchObject({ code: 'file_not_writable' });
      await expect(stat(join(dir, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('never follows a link, a dangling one included', async () => {
    const dir = await tempDir();
    const target = join(dir, 'target.txt');
    const link = join(dir, 'llms.txt');
    await symlink(target, link);
    expect(await refusal(link)).toMatchObject({
      code: 'file_not_writable',
      hint: '--llms-txt: a link, not a regular file',
    });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('reports an unreadable file or a directory instead of writing a new file', async () => {
    const dir = await tempDir();
    const folder = join(dir, 'a', 'llms.txt');
    await mkdir(folder, { recursive: true });
    expect(await refusal(folder)).toMatchObject({
      code: 'file_not_writable',
      hint: '--llms-txt: cannot open the file there',
    });
    expect((await stat(folder)).isDirectory()).toBe(true);
    const locked = join(dir, 'llms.txt');
    await writeFile(locked, '# Mine\n');
    await chmod(locked, 0o000);
    try {
      expect(await refusal(locked)).toMatchObject({
        code: 'file_not_writable',
        hint: '--llms-txt: cannot open the file there',
      });
    } finally {
      await chmod(locked, 0o600);
    }
    expect(await readFile(locked, 'utf-8')).toBe('# Mine\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a named pipe: not a regular file', async () => {
    const dir = await tempDir();
    const fifo = join(dir, 'llms.txt');
    execFileSync('mkfifo', [fifo]);
    expect(await refusal(fifo)).toMatchObject({
      code: 'file_not_writable',
      hint: '--llms-txt: not a regular file',
    });
    expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  it('refuses a file over 1 MiB or holding NUL bytes, unchanged', async () => {
    const dir = await tempDir();
    const big = join(dir, 'big');
    await mkdir(big);
    const bigFile = join(big, 'llms.txt');
    const bigText = 'x'.repeat(MAX_EXISTING_LLMS_BYTES + 1);
    await writeFile(bigFile, bigText);
    expect(await refusal(bigFile)).toMatchObject({
      code: 'file_not_writable',
      hint: '--llms-txt: the file there is over 1 MiB: not an llms.txt',
    });
    expect(await readFile(bigFile, 'utf-8')).toBe(bigText);
    const exact = join(dir, 'exact');
    await mkdir(exact);
    const exactFile = join(exact, 'llms.txt');
    await writeFile(exactFile, 'x'.repeat(MAX_EXISTING_LLMS_BYTES));
    expect(await writeSiteLlmsTxt(exactFile, NPUB, 'Shop')).toBe('appended');
    const binary = join(dir, 'llms.txt');
    await writeFile(binary, 'a\u0000b');
    expect(await refusal(binary)).toMatchObject({
      code: 'file_not_writable',
      hint: '--llms-txt: the file there is not text',
    });
    expect(await readFile(binary, 'utf-8')).toBe('a\u0000b');
  });

  it("appends to a file that names another store's section, and only once for this store", async () => {
    const dir = await tempDir();
    const file = join(dir, 'llms.txt');
    const other = siteLlmsTxt(OTHER_NPUB, 'Other');
    await writeFile(file, other);
    expect(await writeSiteLlmsTxt(file, NPUB, 'Shop')).toBe('appended');
    expect(await readFile(file, 'utf-8')).toBe(`${other}\n${siteLlmsTxtSection(NPUB)}`);
    expect(await writeSiteLlmsTxt(file, NPUB, 'Shop')).toBe('unchanged');
    expect(await readFile(file, 'utf-8')).toBe(`${other}\n${siteLlmsTxtSection(NPUB)}`);
  });

  it('appends after an empty file or one ending in a blank line with no extra blank lines', async () => {
    const dir = await tempDir();
    const empty = join(dir, 'e');
    await mkdir(empty);
    await writeFile(join(empty, 'llms.txt'), '');
    expect(await writeSiteLlmsTxt(join(empty, 'llms.txt'), NPUB, 'Shop')).toBe('appended');
    expect(await readFile(join(empty, 'llms.txt'), 'utf-8')).toBe(siteLlmsTxtSection(NPUB));
    const blank = join(dir, 'llms.txt');
    await writeFile(blank, '# Mine\n\n');
    await writeSiteLlmsTxt(blank, NPUB, 'Shop');
    expect(await readFile(blank, 'utf-8')).toBe(`# Mine\n\n${siteLlmsTxtSection(NPUB)}`);
  });

  it('treats Windows line ends like Unix ones: no extra blank line', async () => {
    const dir = await tempDir();
    const blank = join(dir, 'llms.txt');
    await writeFile(blank, '# Mine\r\n\r\n');
    expect(await writeSiteLlmsTxt(blank, NPUB, 'Shop')).toBe('appended');
    expect(await readFile(blank, 'utf-8')).toBe(`# Mine\r\n\r\n${siteLlmsTxtSection(NPUB)}`);
    const line = join(dir, 'b');
    await mkdir(line);
    await writeFile(join(line, 'llms.txt'), '# Mine\r\n');
    await writeSiteLlmsTxt(join(line, 'llms.txt'), NPUB, 'Shop');
    expect(await readFile(join(line, 'llms.txt'), 'utf-8')).toBe(
      `# Mine\r\n\r\n${siteLlmsTxtSection(NPUB)}`,
    );
  });
});

describe('the site llms.txt, edges', () => {
  it('askr embed --llms-txt writes nothing for a store without settings', async () => {
    const setup = await harness();
    await setup.run(initInvocation(), INIT_ARGS);
    setup.fake.stored = setup.fake.stored.filter((entry) => entry.event.kind !== 30496);
    const dir = await tempDir();
    const file = join(dir, 'llms.txt');
    const outcome = await setup.run({ command: 'embed', options: { llmsTxt: file } }, ['embed']);
    expect(outcome).toMatchObject({ output: { error: { code: 'no_settings' } } });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads an existing llms.txt up to exactly 1 MiB', () => {
    expect(MAX_EXISTING_LLMS_BYTES).toBe(1024 * 1024);
  });

  it("leaves a file that already links this store's llms.txt unchanged", async () => {
    const dir = await tempDir();
    const file = join(dir, 'llms.txt');
    const text = `# Mine\n\n- [Store](${storeLlmsTxtUrl(NPUB)})\n`;
    await writeFile(file, text);
    expect(await writeSiteLlmsTxt(file, NPUB, 'Shop')).toBe('unchanged');
    expect(await readFile(file, 'utf-8')).toBe(text);
  });

  it('askr embed --llms-txt needs a path', async () => {
    const seen: AskrInvocation[] = [];
    const program = new Command().name('elisym');
    registerAskr(
      program,
      async (invocation) => {
        seen.push(invocation);
      },
      ['embed', '--llms-txt'],
      true,
    );
    await expect(
      program.parseAsync(['node', 'elisym', 'askr', 'embed', '--llms-txt']),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
