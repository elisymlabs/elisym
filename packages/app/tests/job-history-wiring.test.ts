/**
 * The three places the job-history store has to be CALLED from, asserted over
 * the source.
 *
 * Reading source in a test is a poor substitute for driving the code, and it is
 * here for one reason: this package has no React or DOM harness
 * (`vitest.config.ts` sets `environment: 'node'` and collects `tests/*.test.ts`
 * only), so the whole wiring layer of the identity-keyed ledger is otherwise
 * untested - a review round proved you could delete the logout purge, delete
 * the migration, or hard-wire the owner to the empty string and the suite would
 * stay green. Each of those is a real regression: rows nobody can see, a
 * provider key leaving its purchases on a shared machine, a history that never
 * arrives.
 *
 * Replace this file with tests that drive the hooks the day this package grows
 * a harness. Until then it is the only thing standing between those three lines
 * and a silent deletion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..', 'app');

function source(relative: string): string {
  return readFileSync(join(APP, relative), 'utf8');
}

describe('the job ledger is wired to the identity', () => {
  it('purges with the identity on logout', () => {
    const purge = source('hooks/useMessages.ts');
    expect(purge).toContain("import { purgeJobHistory } from '~/lib/jobHistory'");
    // Inside `purgeIdentityCaches`, not merely imported somewhere in the file.
    const body = purge.slice(purge.indexOf('export async function purgeIdentityCaches'));
    expect(body).toContain('purgeJobHistory(identityPubkey)');
  });

  it('migrates the legacy wallet store from both hooks that read it', () => {
    const hooks = source('hooks/useJobHistory.ts');
    expect(hooks).toContain('migrateLegacyJobHistory(owner)');
    const uses = hooks.match(/useJobHistoryMigration\(owner, providerSession\)/g) ?? [];
    expect(uses).toHaveLength(2);
  });

  it('takes the owner from the identity, never from a wallet', () => {
    const hooks = source('hooks/useJobHistory.ts');
    expect(hooks).toContain('const { publicKey: owner');
    expect(hooks).not.toContain('useWallet');
    for (const file of [
      'components/JobsNavLink.tsx',
      'routes/Jobs/Jobs.tsx',
      'routes/Jobs/useJobsMerge.ts',
      'routes/Agent/ChatTab.tsx',
    ]) {
      expect(source(file), `${file} still derives a wallet for the ledger`).not.toMatch(
        /readJobs\(wallet\)|clearUnseen\(wallet|useJobHistory\(\{\s*wallet/,
      );
    }
  });

  it('shows the Jobs entry without a wallet, since the ledger no longer needs one', () => {
    const header = source('components/Header.tsx');
    expect(header).not.toMatch(/\(address \|\| providerSession\) && <JobsNavLink/);
  });
});
