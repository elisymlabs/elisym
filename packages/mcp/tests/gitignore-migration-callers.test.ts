/**
 * Every `.gitignore` migration the MCP runs goes through the best-effort
 * wrapper. A structural check, which this package otherwise avoids, and it is
 * here because the behavioural ones were not enough.
 *
 * The rule - a migration never fails the operation it precedes - was applied
 * to four call sites and measured on four, and the fifth, in `iroh.ts`, stayed
 * throwing: it failed `fetch_job_file` on a result already paid for. Nothing
 * was wrong with the four rows. They could not see a call site they did not
 * know existed, and the next one added will be in the same position.
 *
 * So this reads the sources: a call to any `ensureGitignoreHas*` outside the
 * wrapper is a failure, whatever file it turns up in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
/** The wrapper itself names no migration; it is handed one. */
const WRAPPER_FILE = join('storage', 'gitignore-migration.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Call sites of a migration that are NOT an argument to the wrapper. */
function unwrappedCalls(path: string): string[] {
  const text = readFileSync(path, 'utf-8');
  const found: string[] = [];
  const call = /ensureGitignoreHas\w+\(/g;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    // The wrapper takes the migration as an arrow function, so a wrapped call
    // is always preceded, within the same statement, by the wrapper's name.
    const statementStart = text.lastIndexOf(';', match.index);
    const before = text.slice(statementStart + 1, match.index);
    if (!before.includes('migrateGitignoreBestEffort(')) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${relative(SRC, path)}:${line}`);
    }
  }
  return found;
}

describe('a .gitignore migration in the MCP', () => {
  it('is never called outside the best-effort wrapper', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(WRAPPER_FILE))
      .flatMap(unwrappedCalls);

    expect(offenders).toEqual([]);
  });

  it('is actually being looked for - the scan finds the wrapped ones', () => {
    // Without this the row above passes on an empty scan: a renamed helper or a
    // moved `src` would make it vacuous, and it exists to catch a call site
    // nobody knew about.
    const wrapped = sourceFiles(SRC)
      .filter((path) => !path.endsWith(WRAPPER_FILE))
      .filter((path) => /migrateGitignoreBestEffort\(/.test(readFileSync(path, 'utf-8')));

    expect(wrapped.map((path) => relative(SRC, path)).sort()).toEqual([
      'iroh.ts',
      join('storage', 'contacts.ts'),
      join('storage', 'customer-history.ts'),
      join('storage', 'job-sessions.ts'),
      join('storage', 'read-cursors.ts'),
    ]);
  });
});
