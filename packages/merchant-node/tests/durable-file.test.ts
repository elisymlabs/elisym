import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replaceFileDurably } from '../src/durable-file';
import { emptyLedger, loadLedger, saveLedger } from '../src/ledger';

const DURABLE_FILE = fileURLToPath(new URL('../src/durable-file.ts', import.meta.url));

describe('replaceFileDurably', () => {
  it('replaces the file, owner-only, and leaves no temporary file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elisym-durable-'));
    const path = join(directory, 'state.json');
    const temporary = `${path}.tmp`;
    writeFileSync(path, 'old');
    // Left by an earlier write that failed.
    writeFileSync(temporary, 'stale');
    replaceFileDurably(path, temporary, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(existsSync(temporary)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the old file when the write fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elisym-durable-'));
    const path = join(directory, 'state.json');
    writeFileSync(path, 'old');
    expect(() => replaceFileDurably(path, join(directory, 'missing', 'x.tmp'), 'new')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('old');
  });

  it('is how the ledger is saved', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elisym-durable-'));
    const path = join(directory, 'ledger.json');
    saveLedger(path, emptyLedger());
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(loadLedger(path)).toEqual({ state: emptyLedger(), read: 4 });
  });
});

describe('replaceFileDurably under a file size limit', () => {
  it.skipIf(process.platform === 'win32')(
    'throws and keeps the old file when the disk takes only part of it',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'elisym-durable-'));
      const path = join(directory, 'ledger.json');
      writeFileSync(path, 'old');
      const script = [
        `import { replaceFileDurably } from ${JSON.stringify(DURABLE_FILE)};`,
        'try {',
        `  replaceFileDurably(${JSON.stringify(path)}, ${JSON.stringify(`${path}.tmp`)}, 'x'.repeat(200_000));`,
        "  console.log('written');",
        '} catch (error) {',
        "  console.log('refused', error.code);",
        '}',
      ].join('\n');
      const scriptPath = join(directory, 'write.ts');
      writeFileSync(scriptPath, script);
      // `ulimit -f` counts 512-byte blocks: 100 of them is about half the text.
      // SIGXFSZ ignored (inherited through exec): the write fails with EFBIG instead.
      const command = `trap '' XFSZ; ulimit -f 100; bun ${JSON.stringify(scriptPath)}`;
      const result = spawnSync('sh', ['-c', command], {
        encoding: 'utf8',
      });
      expect(result.stdout).toMatch(/^refused EFBIG/);
      expect(readFileSync(path, 'utf8')).toBe('old');
      expect(existsSync(`${path}.tmp`)).toBe(false);
    },
  );
});
